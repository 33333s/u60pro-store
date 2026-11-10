#!/usr/bin/ucode
/* u60pro-hwd: the hardware service of the U60 Pro (ZTE MU5250, SDX75) on plain OpenWrt.  It stands in for the vendor's zte_ubus_bsp_*
 * daemons, which are not part of this system, and talks to the kernel drivers through sysfs and evdev only:
 *
 *   battery   /sys/class/power_supply/battery (Qualcomm fuel gauge), usb (the charger input), battery_zte (ZTE charging policy:
 *             ui_chg_policy_mode 0 = charge, 5 = run from the charger without charging; customer_mode = the long-charge protection)
 *   screen    the backlight /sys/class/leds/led:lcd (AW9523), 0..max_brightness; the 320x480 panel itself belongs to the screen program
 *   keys      /dev/input/event*: the power key (KEY_POWER, the only key of the device), touches count as activity
 *
 * Settings are in UCI (/etc/config/u60pro), state and control on ubus (object u60pro.hw).  Everything that the running kernel does not
 * offer is reported as not available and left alone, so the service runs on any kernel build.
 *
 * U60PRO_ROOT prefixes /sys and /dev (tests run it over a made-up tree); with U60PRO_DRYRUN set, power off and restart are only
 * logged. */
'use strict';

import * as fs from 'fs';
import * as io from 'io';
import * as uloop from 'uloop';
import * as ubus from 'ubus';
import * as uci from 'uci';
import { unpack } from 'struct';

const ROOT = getenv('U60PRO_ROOT') || '';
const PSY = ROOT + '/sys/class/power_supply';
const RUN = getenv('U60PRO_RUN') || '/var/run/u60pro';
const DRYRUN = !!getenv('U60PRO_DRYRUN');
const EV_KEY = 1, EV_ABS = 3;
const KEY_NAMES = { '116': 'KEY_POWER', '102': 'KEY_HOME', '114': 'KEY_VOLUMEDOWN', '115': 'KEY_VOLUMEUP', '408': 'KEY_RESTART', '528': 'KEY_WPS_BUTTON' };
const POLICY_CHARGE = 0, POLICY_HOLD = 5;
/* the long-charge protection of the ZTE battery driver: after this many minutes on the charger at 100 % it holds the battery near 80 %.
 * The period is a 32-bit millisecond counter; 71582 minutes is the longest that fits, which stands for "off". */
const LCP_DEFAULT_MIN = 960, LCP_OFF_MIN = 71582;
const DOUBLE_MS = 350;
const HISTORY_STEP_S = 60, HISTORY_MAX = 2880;

let cfg = {};
let conn = null;
let started = time();

/* ------------------------------------------------------------------ small helpers */
function now_ms() {
	let c = clock(true);
	return c[0] * 1000 + int(c[1] / 1000000);
}
function rd(path) {
	let s = fs.readfile(path);
	return s == null ? null : trim(s);
}
function rd_int(path) {
	let s = rd(path);
	return (s != null && match(s, /^-?[0-9]+$/)) ? +s : null;
}
function wr(path, value) {
	let f = fs.open(path, 'w');
	if (!f) return false;
	let ok = f.write('' + value) != null;
	f.close();
	return ok;
}
function exists(path) { return fs.access(path, 'f') == true || fs.stat(path) != null; }
function log(msg) { warn(sprintf('u60pro-hwd: %s\n', msg)); }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function opt_int(v, def, lo, hi) {
	if (v == null || !match('' + v, /^-?[0-9]+$/)) return def;
	return clamp(+v, lo, hi);
}
function div(v, d) { return v == null ? null : v / d; }
function round(v) { return v == null ? null : int(v + (v < 0 ? -0.5 : 0.5)); }
/* run a shell command without waiting for it */
function spawn(cmd) { system([ '/bin/sh', '-c', '( ' + cmd + ' ) >/dev/null 2>&1 &' ]); }
/* power off or restart the system (never in a test) */
function power(cmd) {
	if (DRYRUN) { warn(sprintf('u60pro-hwd: dry run: %s
', cmd)); return; }
	spawn('sync; ' + cmd);
}

/* ------------------------------------------------------------------ settings */
function load_config() {
	let c = uci.cursor();
	c.load('u60pro');
	let s = c.get_all('u60pro', 'screen') || {}, b = c.get_all('u60pro', 'battery') || {};
	let kmap = {};
	c.foreach('u60pro', 'key', function(k) {
		let code = opt_int(k.code, null, 1, 767);
		if (code == null) return;
		kmap['' + code] = {
			name: k['.name'], code: code,
			short: k.short || 'none', double: k.double || 'none', long: k.long || 'none',
			long_ms: opt_int(k.long_ms, 2000, 500, 10000),
			command_short: k.command_short, command_double: k.command_double, command_long: k.command_long
		};
	});
	cfg = {
		screen: {
			brightness: opt_int(s.brightness, 70, 1, 100),
			timeout: opt_int(s.timeout, 60, 0, 86400),
			dim: s.dim != '0',
			wake_touch: s.wake_touch != '0',
			wake_power: s.wake_power != '0',
			manager: (s.manager in [ 'auto', 'hwd', 'external' ]) ? s.manager : 'auto',
			ui_process: s.ui_process || 'zwrt-devui'
		},
		battery: {
			charge_mode: (b.charge_mode in [ 'normal', 'limit', 'bypass' ]) ? b.charge_mode : 'normal',
			charge_stop: opt_int(b.charge_stop, 80, 20, 100),
			charge_start: opt_int(b.charge_start, 70, 5, 95),
			long_charge_protect: b.long_charge_protect != '0',
			low_shutdown: opt_int(b.low_shutdown, 0, 0, 20)
		},
		net: { data_iface: c.get('u60pro', 'net', 'data_iface') || 'wan' },
		keys: kmap
	};
	if (cfg.battery.charge_start >= cfg.battery.charge_stop)
		cfg.battery.charge_start = cfg.battery.charge_stop - 5;
}

/* ------------------------------------------------------------------ battery and charger */
let bat = { paused: false, policy_ours: false, lcp_ours: false, low_count: 0, history: [], last_sample: 0, last_online: null };

function psy(name, attr) { return PSY + '/' + name + '/' + attr; }
function zte_dir() {
	for (let d in [ PSY + '/battery_zte', ROOT + '/sys/class/power/zte_power/battery_zte' ])
		if (fs.stat(d + '/ui_chg_policy_mode')) return d;
	return null;
}
function powerbank_node() {
	for (let n in (fs.lsdir(PSY) || [])) {
		if (!match(n, /bank|otg/i)) continue;
		for (let a in [ 'online_mbb', 'online' ])
			if (fs.stat(psy(n, a))) return { name: n, path: psy(n, a), present: fs.stat(psy(n, 'present_mbb')) ? psy(n, 'present_mbb') : null };
	}
	return null;
}

function read_battery() {
	let have = fs.stat(PSY + '/battery') != null;
	let cap = rd_int(psy('battery', 'capacity')), uv = rd_int(psy('battery', 'voltage_now')), ua = rd_int(psy('battery', 'current_now'));
	let temp = rd_int(psy('battery', 'temp')), full = rd_int(psy('battery', 'charge_full')), design = rd_int(psy('battery', 'charge_full_design'));
	let status = rd(psy('battery', 'status')), present = rd_int(psy('battery', 'present'));
	let nominal = null, z = zte_dir();
	if (z) nominal = rd_int(z + '/nominal_capacity_mah');
	/* the sign of current_now differs between fuel gauges: make "into the battery" positive from the reported status */
	let ma = ua == null ? null : round(ua / 1000.0);
	if (ma != null) {
		let mag = ma < 0 ? -ma : ma;
		ma = status == 'Charging' ? mag : (status == 'Discharging' ? -mag : ma);
	}
	let mv = uv == null ? null : round(uv / 1000.0);
	return {
		available: have && cap != null,
		present: present == null ? (have && cap != null) : present == 1,
		capacity: cap, status: status, health: rd(psy('battery', 'health')),
		temp_c: temp == null ? null : temp / 10.0,
		voltage_mv: mv, current_ma: ma,
		power_mw: (mv != null && ma != null) ? round(mv * ma / 1000.0) : null,
		charge_full_mah: full == null ? null : round(full / 1000.0),
		design_mah: design != null ? round(design / 1000.0) : (nominal || 10000),
		cycles: rd_int(psy('battery', 'cycle_count')),
		time_to_full_s: rd_int(psy('battery', 'time_to_full_now')) ?? rd_int(psy('battery', 'time_to_full_avg')),
		time_to_empty_s: rd_int(psy('battery', 'time_to_empty_now')) ?? rd_int(psy('battery', 'time_to_empty_avg'))
	};
}

function read_charger() {
	let online = rd_int(psy('usb', 'online')) ?? rd_int(psy('usb', 'present'));
	if (online == null) {
		for (let p in [ psy('charger_zte', 'present_mbb'), psy('type-c_zte', 'present_mbb') ]) {
			let v = rd_int(p);
			if (v != null) { online = v ? 1 : 0; break; }
		}
	}
	let uv = rd_int(psy('usb', 'voltage_now')), ua = rd_int(psy('usb', 'current_now'));
	let mv = uv == null ? null : round(uv / 1000.0), ma = ua == null ? null : round((ua < 0 ? -ua : ua) / 1000.0);
	return {
		available: online != null, online: online == 1,
		type: rd(psy('usb', 'real_type')) ?? rd(psy('usb', 'usb_type')) ?? rd(psy('usb', 'type')),
		voltage_mv: mv, current_ma: ma, power_mw: (mv != null && ma != null) ? round(mv * ma / 1000.0) : null
	};
}

/* single_lcm_period (minutes) from customer_mode_help, the only place the driver shows it */
function lcp_read(z) {
	let help = fs.readfile(z + '/customer_mode_help');
	if (help == null) return null;
	let m = match(help, /single_lcm_period is ([0-9]+)/);
	return { mode: rd_int(z + '/customer_mode'), threshold_min: m ? +m[1] : null };
}

function charge_state() {
	let z = zte_dir(), lcp = z ? lcp_read(z) : null, c = cfg.battery;
	return {
		mode: c.charge_mode, stop: c.charge_stop, start: c.charge_start,
		policy_available: z != null, policy: z ? rd_int(z + '/ui_chg_policy_mode') : null,
		paused: bat.paused, holding: bat.policy_ours,
		long_protect: {
			supported: lcp != null && lcp.threshold_min != null,
			enabled: c.long_charge_protect,
			active: lcp != null && lcp.mode != null && lcp.mode >= 2,
			threshold_min: lcp ? lcp.threshold_min : null
		},
		low_shutdown: c.low_shutdown
	};
}

/* The charging policy: "limit" stops at charge_stop and starts again at charge_start, "bypass" never charges while the charger is in
 * (the device runs from it), a pause from ubus holds until it is lifted or the charger is pulled.  Policy 5 only ever stands while we
 * asked for it: on the way out (and at start) it is put back to 0. */
function charge_tick(b, ch) {
	let z = zte_dir();
	if (!z) return;
	let c = cfg.battery, hold = false;
	if (!ch.online) bat.paused = false;
	if (ch.online && b.available) {
		if (bat.paused || c.charge_mode == 'bypass') hold = true;
		else if (c.charge_mode == 'limit')
			hold = bat.policy_ours ? b.capacity > c.charge_start : b.capacity >= c.charge_stop;
	}
	let cur = rd_int(z + '/ui_chg_policy_mode');
	if (hold && cur != POLICY_HOLD) {
		if (wr(z + '/ui_chg_policy_mode', POLICY_HOLD)) log(sprintf('charging held at %d %% (%s)', b.capacity, bat.paused ? 'paused' : c.charge_mode));
	} else if (!hold && bat.policy_ours && cur == POLICY_HOLD) {
		if (wr(z + '/ui_chg_policy_mode', POLICY_CHARGE)) log(sprintf('charging resumed at %d %%', b.capacity ?? -1));
	}
	bat.policy_ours = hold;

	/* the long-charge protection lives in kernel memory: when switched off here it is written again whenever the driver shows the default */
	let lcp = lcp_read(z);
	if (lcp && lcp.threshold_min != null) {
		if (!c.long_charge_protect && lcp.threshold_min != LCP_OFF_MIN) {
			if (wr(z + '/customer_mode', '2 ' + LCP_OFF_MIN)) { bat.lcp_ours = true; log('long-charge protection off'); }
		} else if (c.long_charge_protect && bat.lcp_ours) {
			wr(z + '/customer_mode', '1 1');
			bat.lcp_ours = false;
			log('long-charge protection back to the driver default');
		}
	}
}

/* switch off before the battery is empty: only on battery, only with a sane reading, and only after it held for a minute */
function low_tick(b, ch) {
	let thr = cfg.battery.low_shutdown;
	let low = thr > 0 && b.available && b.present && !ch.online && b.status == 'Discharging' && b.capacity != null && b.capacity <= thr
		&& b.voltage_mv != null && b.voltage_mv > 2500 && b.voltage_mv < 3700 && (time() - started) > 120;
	bat.low_count = low ? bat.low_count + 1 : 0;
	if (bat.low_count >= 6) {
		log(sprintf('battery at %d %% (%d mV): powering off', b.capacity, b.voltage_mv));
		bat.low_count = 0;
		power('poweroff');
	}
}

function history_tick(b, ch) {
	let t = time();
	if (!b.available || t - bat.last_sample < HISTORY_STEP_S) return;
	bat.last_sample = t;
	push(bat.history, [ t, b.capacity, ch.online ? (b.status == 'Charging' ? 'C' : (b.status == 'Full' ? 'F' : 'P')) : 'D', b.power_mw, b.temp_c ]);
	if (length(bat.history) > HISTORY_MAX) shift(bat.history);
}

/* per cent an hour over the last stretch on battery (up to an hour), and the time left from it */
function drain_estimate(b) {
	let h = bat.history, n = length(h), i = n - 1;
	if (n < 5 || h[i][2] != 'D') return null;
	while (i > 0 && h[i - 1][2] == 'D' && h[n - 1][0] - h[i - 1][0] <= 3600) i--;
	let dt = h[n - 1][0] - h[i][0], dp = h[i][1] - h[n - 1][1];
	if (dt < 300 || dp <= 0) return null;
	let per_hour = dp * 3600.0 / dt;
	return { per_hour: per_hour, left_s: round(b.capacity / per_hour * 3600) };
}

/* ------------------------------------------------------------------ screen (backlight) */
let scr = { path: null, max: 255, on: true, dimmed: false, last_activity: now_ms(), timer: null };

function bl_find() {
	for (let d in [ ROOT + '/sys/class/leds/led:lcd' ])
		if (fs.stat(d + '/brightness')) return d;
	for (let n in (fs.lsdir(ROOT + '/sys/class/backlight') || []))
		if (fs.stat(ROOT + '/sys/class/backlight/' + n + '/brightness')) return ROOT + '/sys/class/backlight/' + n;
	return null;
}
function bl_level(pct) { return clamp(round(scr.max * pct / 100.0), 1, scr.max); }
function bl_write(v) { if (scr.path) wr(scr.path + '/brightness', v); }

/* whether this service runs the backlight and the key, or a screen program does (zwrt-devui has its own power key handling) */
let ui_seen = { t: 0, running: false };
function ui_running() {
	let t = now_ms();
	if (t - ui_seen.t < 3000 && ui_seen.t) return ui_seen.running;
	ui_seen.t = t;
	ui_seen.running = false;
	let want = cfg.screen.ui_process;
	for (let pid in (fs.lsdir(ROOT + '/proc') || [])) {
		if (!match(pid, /^[0-9]+$/)) continue;
		let comm = rd(ROOT + '/proc/' + pid + '/comm');
		if (comm != null && comm == substr(want, 0, 15)) { ui_seen.running = true; break; }
	}
	return ui_seen.running;
}
function screen_ours() {
	let m = cfg.screen.manager;
	return m == 'hwd' || (m == 'auto' && !ui_running());
}

let screen_set;
function screen_arm() {
	if (scr.timer) { scr.timer.cancel(); scr.timer = null; }
	let t = cfg.screen.timeout;
	if (!scr.on || t <= 0 || !screen_ours()) return;
	let lead = (cfg.screen.dim && t > 10) ? 5 : 0;
	if (scr.dimmed) {
		scr.timer = uloop.timer(5000, function() { scr.timer = null; screen_set(false); });
	} else {
		scr.timer = uloop.timer((t - lead) * 1000, function() {
			scr.timer = null;
			if (lead) {
				scr.dimmed = true;
				bl_write(clamp(round(bl_level(cfg.screen.brightness) * 0.3), 1, scr.max));
				screen_arm();
			} else screen_set(false);
		});
	}
}
screen_set = function(on) {
	if (!scr.path) return false;
	scr.on = !!on;
	scr.dimmed = false;
	bl_write(on ? bl_level(cfg.screen.brightness) : 0);
	screen_arm();
	return true;
};
function screen_activity() {
	scr.last_activity = now_ms();
	if (!screen_ours()) return;
	if (scr.on && scr.dimmed) { scr.dimmed = false; bl_write(bl_level(cfg.screen.brightness)); }
	screen_arm();
}
function screen_init() {
	scr.path = bl_find();
	if (!scr.path) return;
	scr.max = rd_int(scr.path + '/max_brightness') || 255;
	let cur = rd_int(scr.path + '/brightness');
	scr.on = cur == null || cur > 0;
	if (screen_ours() && scr.on) bl_write(bl_level(cfg.screen.brightness));
	screen_arm();
}
function screen_state() {
	let cur = scr.path ? rd_int(scr.path + '/brightness') : null, ours = screen_ours();
	if (!ours && cur != null) scr.on = cur > 0;
	return {
		available: scr.path != null, on: scr.path ? scr.on : null, dimmed: scr.dimmed,
		brightness: cfg.screen.brightness, level: cur, max: scr.max, timeout: cfg.screen.timeout,
		manager: ours ? 'hwd' : 'external', ui_process: cfg.screen.ui_process, ui_running: ui_running(),
		idle_s: int((now_ms() - scr.last_activity) / 1000),
		resolution: '320x480'
	};
}

/* ------------------------------------------------------------------ actions */
function powerbank_set(on) {
	let n = powerbank_node();
	return n ? wr(n.path, on ? 1 : 0) : false;
}
function powerbank_state() {
	let n = powerbank_node();
	return { available: n != null, enabled: n ? rd_int(n.path) == 1 : null, present: (n && n.present) ? rd_int(n.present) == 1 : null };
}

const ACTIONS = {
	none: function() {},
	screen_toggle: function() { screen_set(!scr.on); },
	screen_on: function() { screen_set(true); },
	screen_off: function() { screen_set(false); },
	wifi_toggle: function() {
		spawn('if ubus call network.wireless status | grep -q \'"up": true\'; then wifi down; else wifi up; fi');
	},
	data_toggle: function() {
		let i = cfg.net.data_iface;
		if (match(i, /^[A-Za-z0-9_.-]+$/))
			spawn('if ubus call network.interface.' + i + ' status | grep -q \'"up": true\'; then ifdown ' + i + '; else ifup ' + i + '; fi');
	},
	powerbank_toggle: function() { let s = powerbank_state(); if (s.available) powerbank_set(!s.enabled); },
	poweroff: function() { power('poweroff'); },
	reboot: function() { power('reboot'); }
};

/* ------------------------------------------------------------------ keys */
let kb = { devices: {}, count: 0, log: [], state: {} };

function key_log(code, gesture, action) {
	unshift(kb.log, { t: time(), code: code, name: KEY_NAMES['' + code] || ('KEY_' + code), gesture: gesture, action: action });
	if (length(kb.log) > 12) pop(kb.log);
}
function key_fire(k, code, gesture) {
	let action = k ? (k[gesture] || 'none') : 'none', ran = action;
	/* a screen program owns the key: it gets the events itself, we only record them */
	if (!screen_ours()) ran = 'external';
	else if (!scr.on && gesture == 'short' && action != 'screen_toggle' && action != 'screen_on' && scr.path) {
		/* a short press on a dark screen always lights it first */
		screen_set(true);
		ran = 'screen_on';
	} else if (action == 'command') {
		let cmd = k['command_' + gesture];
		if (cmd) spawn(cmd); else ran = 'none';
	} else if (ACTIONS[action]) ACTIONS[action]();
	else ran = 'none';
	key_log(code, gesture, ran);
}
function key_event(code, value) {
	let id = '' + code, k = cfg.keys[id], st = kb.state[id];
	if (!st) st = kb.state[id] = { down: false, long: null, long_fired: false, single: null };
	if (value == 1) {
		kb.count++;
		st.down = true;
		st.long_fired = false;
		if (st.long) st.long.cancel();
		st.long = uloop.timer(k ? k.long_ms : 2000, function() {
			st.long = null;
			if (!st.down) return;
			st.long_fired = true;
			if (st.single) { st.single.cancel(); st.single = null; }
			key_fire(k, code, 'long');
		});
	} else if (value == 0 && st.down) {
		st.down = false;
		if (st.long) { st.long.cancel(); st.long = null; }
		if (st.long_fired) return;
		if (k && k.double != 'none') {
			if (st.single) {
				st.single.cancel(); st.single = null;
				key_fire(k, code, 'double');
			} else st.single = uloop.timer(DOUBLE_MS, function() { st.single = null; key_fire(k, code, 'short'); });
		} else key_fire(k, code, 'short');
	}
}

function input_scan() {
	let dir = ROOT + '/dev/input', seen = {};
	for (let n in (fs.lsdir(dir) || [])) {
		if (!match(n, /^event[0-9]+$/)) continue;
		seen[n] = true;
		if (kb.devices[n]) continue;
		let h = io.open(dir + '/' + n, io.O_RDWR | io.O_NONBLOCK) || io.open(dir + '/' + n, io.O_RDONLY | io.O_NONBLOCK);
		if (!h) continue;
		/* a touch screen reports absolute axes (capabilities/abs is not all zeroes) */
		let abs = rd(ROOT + '/sys/class/input/' + n + '/device/capabilities/abs');
		let dev = { name: rd(ROOT + '/sys/class/input/' + n + '/device/name') || n, handle: h, touch: abs != null && match(abs, /[1-9a-f]/) != null };
		dev.watch = uloop.handle(h, function() {
			let d, touched = false;
			/* struct input_event on a 64-bit kernel: 16 bytes of time, type, code, value */
			while ((d = h.read(24)) != null && length(d) == 24) {
				let e = unpack('<qqHHi', d);
				/* keys proper; the buttons from 0x100 up (BTN_TOUCH and the like) are touches */
				if (e[2] == EV_KEY && (e[3] < 0x100 || KEY_NAMES['' + e[3]])) {
					key_event(e[3], e[4]);
					touched = true;
				} else if (e[2] == EV_ABS || e[2] == EV_KEY) {
					dev.touch = true;
					touched = true;
				}
			}
			if (touched) {
				if (dev.touch && !scr.on && cfg.screen.wake_touch && screen_ours()) screen_set(true);
				screen_activity();
			}
		}, uloop.ULOOP_READ);
		kb.devices[n] = dev;
	}
	for (let n in keys(kb.devices)) {
		if (seen[n]) continue;
		kb.devices[n].watch.delete();
		kb.devices[n].handle.close();
		delete kb.devices[n];
	}
}

/* ------------------------------------------------------------------ status */
function thermal() {
	let zones = [], soc = null, dir = ROOT + '/sys/class/thermal';
	for (let n in sort(fs.lsdir(dir) || [])) {
		if (!match(n, /^thermal_zone[0-9]+$/)) continue;
		let type = rd(dir + '/' + n + '/type'), t = rd_int(dir + '/' + n + '/temp');
		if (type == null || t == null || t <= -40000 || t > 200000) continue;
		let c = t / 1000.0;
		push(zones, { type: type, temp_c: c });
		if (match(type, /cpu|cpuss|soc|aoss/i) && (soc == null || c > soc)) soc = c;
	}
	if (soc == null && length(zones)) for (let z in zones) if (soc == null || z.temp_c > soc) soc = z.temp_c;
	return { soc_c: soc, zones: zones };
}

function status() {
	let b = read_battery(), ch = read_charger(), est = drain_estimate(b);
	if (est) { b.drain_per_hour = est.per_hour; if (b.time_to_empty_s == null) b.time_to_empty_s = est.left_s; }
	let devs = [];
	for (let n in kb.devices) push(devs, { dev: n, name: kb.devices[n].name, touch: kb.devices[n].touch });
	let kc = [];
	for (let id in cfg.keys) push(kc, cfg.keys[id]);
	return {
		model: 'MU5250', now: time(), uptime_s: int(+split(rd('/proc/uptime') || '0', ' ')[0]),
		battery: b, charger: ch, charge: charge_state(), powerbank: powerbank_state(),
		screen: screen_state(),
		keys: { ready: length(devs) > 0, devices: devs, count: kb.count, log: kb.log, config: kc },
		thermal: thermal()
	};
}

function tick() {
	let b = read_battery(), ch = read_charger();
	charge_tick(b, ch);
	low_tick(b, ch);
	history_tick(b, ch);
	/* plugging the charger in or out lights the screen */
	if (bat.last_online != null && bat.last_online != ch.online && cfg.screen.wake_power && screen_ours()) {
		if (!scr.on) screen_set(true); else screen_activity();
	}
	bat.last_online = ch.online;
}

/* ------------------------------------------------------------------ ubus */
function history(req) {
	let want = opt_int(req.args?.minutes, 1440, 10, HISTORY_MAX), t0 = time() - want * 60, out = [];
	for (let h in bat.history) if (h[0] >= t0) push(out, h);
	return { step_s: HISTORY_STEP_S, samples: out };
}

const METHODS = {
	status: { call: function(req) { return status(); }, args: { ubus_rpc_session: '' } },
	history: { call: history, args: { minutes: 0, ubus_rpc_session: '' } },
	/* power: on, off or toggle; brightness: 1..100 shown at once (saved only by the settings page) */
	screen: {
		call: function(req) {
			let a = req.args || {};
			if (!scr.path) return { ok: false, error: 'no backlight' };
			if (a.brightness != null && a.brightness != 0) {
				cfg.screen.brightness = clamp(int(a.brightness), 1, 100);
				if (scr.on) { scr.dimmed = false; bl_write(bl_level(cfg.screen.brightness)); }
			}
			if (a.power == 'on') screen_set(true);
			else if (a.power == 'off') screen_set(false);
			else if (a.power == 'toggle') screen_set(!scr.on);
			else screen_activity();
			return { ok: true, screen: screen_state() };
		},
		args: { power: '', brightness: 0, ubus_rpc_session: '' }
	},
	/* hold charging until the charger is pulled (or lift the hold) */
	charging: {
		call: function(req) {
			if (!zte_dir()) return { ok: false, error: 'no charging policy control in this kernel' };
			bat.paused = !!req.args?.paused;
			tick();
			return { ok: true, charge: charge_state() };
		},
		args: { paused: true, ubus_rpc_session: '' }
	},
	powerbank: {
		call: function(req) {
			if (!powerbank_node()) return { ok: false, error: 'no reverse charging control in this kernel' };
			let ok = powerbank_set(!!req.args?.enabled);
			return { ok: ok, powerbank: powerbank_state() };
		},
		args: { enabled: true, ubus_rpc_session: '' }
	},
	reload: {
		call: function(req) {
			load_config();
			if (screen_ours() && scr.on && scr.path) bl_write(bl_level(cfg.screen.brightness));
			scr.dimmed = false;
			screen_arm();
			tick();
			return { ok: true };
		},
		args: {}
	}
};

/* ------------------------------------------------------------------ main */
function leave() {
	/* give charging back to the driver */
	let z = zte_dir();
	if (z && bat.policy_ours) wr(z + '/ui_chg_policy_mode', POLICY_CHARGE);
	uloop.end();
}

uloop.init();
load_config();
fs.mkdir(RUN);
screen_init();
input_scan();
/* a hold left behind by a run that was killed */
if (zte_dir() && rd_int(zte_dir() + '/ui_chg_policy_mode') == POLICY_HOLD && exists(RUN + '/hold')) bat.policy_ours = true;
tick();

conn = ubus.connect();
if (conn) conn.publish('u60pro.hw', METHODS);
else log('no ubus: running without the control interface');

uloop.interval(10000, function() {
	tick();
	if (bat.policy_ours) wr(RUN + '/hold', '1'); else fs.unlink(RUN + '/hold');
});
uloop.interval(30000, input_scan);
uloop.signal('SIGTERM', leave);
uloop.signal('SIGINT', leave);
uloop.run();
