/* rpcd methods of the U60 Pro theme's overview page.  usage: ucode dashboard.uc <state|wifi_set>   (JSON arguments on stdin)
 *   state     the device clock, the uplink (the interface of the default route: name, protocol, address, byte counters and the rate
 *             between this call and the previous one), the Wi-Fi access points, the number of DHCP clients, and the cellular link when
 *             a modem service publishes it (/var/run/u60pro/cell.json: {connected, operator, rat, rsrp, sinr, band})
 *   wifi_set  {enabled}: bring all radios up or down (wifi up / wifi down), as the Wi-Fi tile's switch does
 * The battery, screen and key come from the hardware service itself (ubus u60pro.hw). */
import { readfile, writefile, stat, popen } from 'fs';
import { connect } from 'ubus';

const RUN = '/var/run/u60pro-dashboard';
const CELL = getenv('U60PRO_CELL') || '/var/run/u60pro/cell.json';
let method = ARGV[0];
let args;
try { args = json(trim(readfile('/dev/stdin') || '') || '{}'); } catch (e) { args = {}; }
if (type(args) != 'object') args = {};

function out(v) { printf('%J\n', v); exit(0); }
function json_file(path) {
	try { return json(readfile(path) || 'null'); } catch (e) { return null; }
}
function run(cmd) {
	let p = popen(cmd, 'r');
	if (!p) return '';
	let s = p.read('all') || '';
	p.close();
	return s;
}
function now_ms() {
	return int(+split(trim(readfile('/proc/uptime') || '0'), ' ')[0] * 1000);
}

/* bytes per second on the uplink since the previous call of any client (kept in /var/run); null on the first call or after a counter
 * reset.  Within 0.5 s of the previous sample the previous rate is repeated. */
function rates(dev) {
	if (!dev || !match(dev, /^[A-Za-z0-9_.@-]+$/)) return null;
	let base = '/sys/class/net/' + dev + '/statistics/';
	let rxs = readfile(base + 'rx_bytes'), txs = readfile(base + 'tx_bytes');
	if (rxs == null || txs == null) return null;
	let rx = +trim(rxs), tx = +trim(txs);
	let t = now_ms(), prev = json_file(RUN + '/rate.json'), r = { rx_total: rx, tx_total: tx, rx_bps: null, tx_bps: null };
	if (prev && prev.dev == dev && t > prev.t && rx >= prev.rx && tx >= prev.tx) {
		if (t - prev.t < 500 && prev.rx_bps != null) {
			r.rx_bps = prev.rx_bps; r.tx_bps = prev.tx_bps;
			return r;
		}
		r.rx_bps = (rx - prev.rx) * 1000.0 / (t - prev.t);
		r.tx_bps = (tx - prev.tx) * 1000.0 / (t - prev.t);
	}
	if (!stat(RUN)) system([ 'mkdir', '-p', RUN ]);
	writefile(RUN + '/rate.json', sprintf('%J', { dev: dev, t: t, rx: rx, tx: tx, rx_bps: r.rx_bps, tx_bps: r.tx_bps }));
	return r;
}

/* the interface that carries the IPv4 default route (the lowest metric), else the IPv6 one */
function uplink(conn) {
	let dump = conn ? conn.call('network.interface', 'dump') : null, best = null;
	for (let i in (dump?.interface || [])) {
		if (!i.up || i.interface == 'loopback') continue;
		for (let r in (i.route || [])) {
			if (r.mask != 0) continue;
			let m = (i.metric || 0) + (r.target == '::' ? 100000 : 0);
			if (!best || m < best.m) best = { m: m, i: i };
		}
	}
	if (!best) return { up: false };
	let i = best.i, dev = i.l3_device || i.device;
	let addr = i['ipv4-address']?.[0]?.address || i['ipv6-address']?.[0]?.address;
	return { up: true, name: i.interface, proto: i.proto, device: dev, address: addr, uptime_s: i.uptime, rates: rates(dev) };
}

function wifi(conn) {
	let st = conn ? conn.call('network.wireless', 'status') : null, aps = [], radios = 0, up = false;
	for (let name in (st || {})) {
		let r = st[name];
		radios++;
		if (r.up) up = true;
		for (let i in (r.interfaces || [])) {
			let c = i.config || {};
			if (c.mode != 'ap') continue;
			push(aps, { ssid: c.ssid, band: r.config?.band, device: i.ifname, open: !c.encryption || c.encryption == 'none', up: !!r.up });
		}
	}
	let stations = 0;
	for (let a in aps) {
		if (!a.device) continue;
		let l = conn.call('iwinfo', 'assoclist', { device: a.device });
		stations += length(l?.results || []);
	}
	return { available: radios > 0, radios: radios, up: up, aps: aps, stations: stations };
}

function clients() {
	let n = 0, leases = readfile('/tmp/dhcp.leases');
	for (let l in split(leases || '', '\n')) if (length(trim(l))) n++;
	return n;
}

function tz_offset() {
	let m = match(trim(run('date +%z')), /^([+-])([0-9]{2})([0-9]{2})$/);
	return m ? (m[1] == '-' ? -1 : 1) * (+m[2] * 3600 + +m[3] * 60) : 0;
}

if (method == 'state') {
	let conn = connect(), board = conn ? conn.call('system', 'board') : null;
	let cell = json_file(CELL), st = stat(CELL);
	/* a cellular state the modem service has not refreshed for a minute is not shown */
	if (cell && st && time() - st.mtime > 60) cell = null;
	out({
		now: time(), tz_offset_s: tz_offset(),
		uptime_s: int(+split(trim(readfile('/proc/uptime') || '0'), ' ')[0]),
		hostname: board?.hostname, release: board?.release?.version, kernel: board?.kernel,
		uplink: uplink(conn), wifi: wifi(conn), clients: clients(), cell: cell
	});
}
else if (method == 'wifi_set') {
	let on = args.enabled === true || args.enabled == '1' || args.enabled == 1;
	system([ '/bin/sh', '-c', (on ? 'wifi up' : 'wifi down') + ' >/dev/null 2>&1 &' ]);
	out({ ok: true, enabled: on });
}
out({ error: 'unknown method' });
