'use strict';
'require view';
'require rpc';
'require ui';
'require poll';

/* Overview of the U60 Pro theme: the front of the device (ZTE MU5250: 73 x 158 mm, a 3.5" 320x480 touch screen in the upper part, the
 * red power key on the right edge, the NFC mark below the screen, USB-C at the bottom), its screen showing a home page drawn here from
 * live data whether the real screen is on or not, and tiles for the network, Wi-Fi, battery, screen, reverse charging, clients and
 * system.  The screen opens System > Screen, the power key System > Buttons, the USB-C port System > Power, the tiles their pages. */

/* Everything the system itself knows comes from its standard ubus objects (procd's system, netifd's network.*, rpcd's luci-rpc and
 * iwinfo); only what OpenWrt has no interface for is asked of the device's own objects: u60pro.hw (battery, backlight, key; package
 * u60pro-hw) and u60pro.cell (the cellular link, when a modem service publishes it). */
var callBoard = rpc.declare({ object: 'system', method: 'board' });
var callInfo = rpc.declare({ object: 'system', method: 'info' });
var callIfaces = rpc.declare({ object: 'network.interface', method: 'dump', expect: { 'interface': [] } });
var callDevice = rpc.declare({ object: 'network.device', method: 'status', params: [ 'name' ] });
var callWireless = rpc.declare({ object: 'network.wireless', method: 'status' });
var callWifiUp = rpc.declare({ object: 'network.wireless', method: 'up' });
var callWifiDown = rpc.declare({ object: 'network.wireless', method: 'down' });
var callLeases = rpc.declare({ object: 'luci-rpc', method: 'getDHCPLeases', expect: { dhcp_leases: [] } });
var callAssoc = rpc.declare({ object: 'iwinfo', method: 'assoclist', params: [ 'device' ], expect: { results: [] } });
var callCell = rpc.declare({ object: 'u60pro.cell', method: 'status' });
var callHw = rpc.declare({ object: 'u60pro.hw', method: 'status' });
var callScreen = rpc.declare({ object: 'u60pro.hw', method: 'screen', params: [ 'power' ] });
var callBank = rpc.declare({ object: 'u60pro.hw', method: 'powerbank', params: [ 'enabled' ] });

var LINK = { network: 'admin/network/network', wifi: 'admin/network/wireless', battery: 'admin/status/u60pro-battery',
	power: 'admin/system/u60pro-power', screen: 'admin/system/u60pro-screen', key: 'admin/system/u60pro-buttons',
	clients: 'admin/network/dhcp', system: 'admin/status/overview' };
/* the pages of luci-app-u60pro; without it the tile says so instead of opening a missing page */
var APP = { battery: 1, power: 1, screen: 1, key: 1 };

function menuHas(tree, path) {
	var n = tree;
	path.split('/').forEach(function(p) { n = n && n.children && n.children[p]; });
	return !!n;
}

/* ------------------------------------------------------------------ helpers */
function icon(name) {
	var s = E('span', { 'class': 'u-ic', 'aria-hidden': 'true' });
	s.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
		((window.U60_ICONS || {})[name] || '') + '</svg>';
	return s;
}
function num(v) { return typeof v === 'number' && isFinite(v) ? v : (typeof v === 'string' && v !== '' && isFinite(+v) ? +v : null); }
function pad(n) { return (n < 10 ? '0' : '') + n; }
function txt(el, s) { s = String(s); if (el.textContent !== s) el.textContent = s; }
/* network rates in bits per second, as the device's screen shows them */
function fmtRate(Bps) {
	if (Bps == null) return [ '–', 'Kbps' ];
	var b = Bps * 8;
	if (b < 1e6) { var k = b / 1e3; return [ k < 10 ? k.toFixed(1) : k.toFixed(0), 'Kbps' ]; }
	if (b < 1e9) { var m = b / 1e6; return [ m < 10 ? m.toFixed(1) : m.toFixed(0), 'Mbps' ]; }
	return [ (b / 1e9).toFixed(2), 'Gbps' ];
}
function fmtBytes(n) {
	if (n == null) return '–';
	var u = [ 'B', 'KB', 'MB', 'GB', 'TB' ], i = 0;
	while (n >= 1000 && i < u.length - 1) { n /= 1024; i++; }
	return (n < 10 && i ? n.toFixed(2) : n < 100 && i ? n.toFixed(1) : n.toFixed(0)) + ' ' + u[i];
}
function fmtSleep(s) {
	if (s == null) return '–';
	if (s === 0) return _('Always on');
	return s < 60 ? _('%d s').format(s) : _('%d min').format(s / 60);
}
function fmtDur(s) {
	if (s == null) return '–';
	if (s >= 86400) return _('%d d %d h').format(Math.floor(s / 86400), Math.floor(s % 86400 / 3600));
	if (s >= 3600) return _('%d h %d min').format(Math.floor(s / 3600), Math.floor(s % 3600 / 60));
	return _('%d min').format(Math.floor(s / 60));
}
function fmtShort(s) {
	if (s == null) return '–';
	if (s >= 86400) return Math.floor(s / 86400) + 'd ' + Math.floor(s % 86400 / 3600) + 'h';
	if (s >= 3600) return Math.floor(s / 3600) + 'h ' + Math.floor(s % 3600 / 60) + 'm';
	return Math.floor(s / 60) + 'm';
}
function rgb(hex) { var v = parseInt(hex.slice(1), 16); return [ v >> 16 & 255, v >> 8 & 255, v & 255 ]; }
function css(c, a) { return a == null || a >= 255 ? 'rgb(' + c.join(',') + ')' : 'rgba(' + c.join(',') + ',' + (a / 255).toFixed(3) + ')'; }
function mix(bg, fg, a) { return [ 0, 1, 2 ].map(function(i) { return Math.round((bg[i] * (255 - a) + fg[i] * a) / 255); }); }
function fail(e) { ui.addNotification(null, E('p', {}, (e && e.message) || String(e)), 'error'); }

var THEMES = [ { a: '#38D0FF', b: '#FF7AC8' }, { a: '#4ADE80', b: '#FFC857' }, { a: '#FF9F43', b: '#6C8CFF' }, { a: '#A78BFA', b: '#2DD4BF' } ];
var C_TXT = rgb('#F2F6FA'), C_DIM = rgb('#93A4B8'), C_FAINT = rgb('#56677A'), C_OK = rgb('#4ADE80'), C_WARN = rgb('#FBBF24'), C_BAD = rgb('#F87171'), INK = rgb('#10151F');
var WDAY = [ '周日', '周一', '周二', '周三', '周四', '周五', '周六' ];
var FONT = (getComputedStyle(document.documentElement).getPropertyValue('--font-sans') || 'system-ui, sans-serif').trim();

/* ------------------------------------------------------------------ state */
var S = { st: null, hw: null, skew: 0, theme: 1 };
var board = null, lastRate = null;

/* the interface that carries the IPv4 default route (the lowest metric), else the IPv6 one */
function pickUplink(ifaces) {
	var best = null;
	(ifaces || []).forEach(function(i) {
		if (!i.up || i.interface === 'loopback') return;
		(i.route || []).forEach(function(r) {
			if (r.mask !== 0) return;
			var m = (i.metric || 0) + (r.target === '::' ? 100000 : 0);
			if (!best || m < best.m) best = { m: m, i: i };
		});
	});
	if (!best) return { up: false };
	var i = best.i, a4 = (i['ipv4-address'] || [])[0], a6 = (i['ipv6-address'] || [])[0];
	return { up: true, name: i.interface, proto: i.proto, device: i.l3_device || i.device, address: (a4 || a6 || {}).address, uptime_s: i.uptime };
}

/* bytes per second on the uplink between this sample and the previous one of this page */
function rateOf(dev, st) {
	var s = st && st.statistics, now = Date.now();
	if (!s || s.rx_bytes == null) return null;
	var r = { rx_total: s.rx_bytes, tx_total: s.tx_bytes, rx_bps: null, tx_bps: null }, p = lastRate;
	if (p && p.dev === dev && now > p.t && s.rx_bytes >= p.rx && s.tx_bytes >= p.tx) {
		r.rx_bps = (s.rx_bytes - p.rx) * 1000 / (now - p.t);
		r.tx_bps = (s.tx_bytes - p.tx) * 1000 / (now - p.t);
	}
	lastRate = { dev: dev, t: now, rx: s.rx_bytes, tx: s.tx_bytes };
	return r;
}

/* one sample of the system: {now, uptime_s, hostname, uplink, wifi, clients, cell}.  `now` is the device's local time, so the clock
 * on the drawn screen is the device's and not the browser's. */
function gather() {
	return Promise.all([
		board ? board : L.resolveDefault(callBoard(), null),
		L.resolveDefault(callInfo(), null),
		L.resolveDefault(callIfaces(), []),
		L.resolveDefault(callWireless(), null),
		L.resolveDefault(callLeases(), []),
		L.resolveDefault(callCell(), null)
	]).then(function(r) {
		board = r[0];
		var info = r[1], up = pickUplink(r[2]), radios = r[3] || {}, aps = [], n = 0, anyUp = false;
		Object.keys(radios).forEach(function(name) {
			var radio = radios[name];
			n++;
			if (radio.up) anyUp = true;
			(radio.interfaces || []).forEach(function(i) {
				var c = i.config || {};
				if (c.mode === 'ap') aps.push({ ssid: c.ssid, device: i.ifname, up: !!radio.up });
			});
		});
		var st = {
			now: info ? info.localtime : null, uptime_s: info ? info.uptime : null, hostname: board ? board.hostname : null,
			uplink: up, wifi: { available: n > 0, up: anyUp, aps: aps, stations: 0 }, clients: r[4].length,
			cell: r[5] && r[5].connected != null ? r[5] : null
		};
		return Promise.all([ up.up && up.device ? L.resolveDefault(callDevice(up.device), null) : null ].concat(
			aps.filter(function(a) { return a.up && a.device; }).map(function(a) { return L.resolveDefault(callAssoc(a.device), []); })
		)).then(function(q) {
			if (up.up) up.rates = rateOf(up.device, q[0]);
			q.slice(1).forEach(function(l) { st.wifi.stations += l.length; });
			return st;
		});
	}).catch(function() { return null; });
}
function battery() {
	var b = S.hw && S.hw.battery, c = S.hw && S.hw.charger, g = S.hw && S.hw.charge;
	if (!b || !b.available) return null;
	return { pct: num(b.capacity), charging: b.status === 'Charging', full: b.status === 'Full', online: !!(c && c.online),
		paused: !!(g && g.holding), mw: c ? num(c.power_mw) : null };
}
function batteryState(b) {
	if (!b) return '–';
	if (b.charging) return _('Charging');
	if (b.full) return _('Full');
	if (b.online && b.paused) return _('Charging paused');
	return b.online ? _('External power') : _('On battery');
}
function cell() { return S.st && S.st.cell; }
function uplink() { return (S.st && S.st.uplink) || {}; }
/* what the screen's operator line says */
function linkText() {
	var c = cell(), u = uplink();
	if (c && c.connected) return c.operator || '已连接';
	if (u.up) return (u.name || '').toUpperCase() || '已连接';
	if (!S.st) return '启动中';
	return c ? '未注册' : '未连接';
}
function linkPill() {
	var c = cell(), u = uplink();
	if (c && c.connected && c.rat) return c.rat;
	return u.up && u.proto ? String(u.proto).toUpperCase() : '';
}
function signalBars() {
	var c = cell();
	if (!c || !c.connected) return uplink().up ? 4 : 0;
	if (num(c.bars) != null) return Math.max(0, Math.min(4, num(c.bars)));
	var r = num((c.nr || {}).rsrp);
	if (r == null) r = num((c.lte || {}).rsrp);
	return r == null ? 0 : r >= -85 ? 4 : r >= -95 ? 3 : r >= -105 ? 2 : r >= -115 ? 1 : 0;
}
function rates() { return uplink().rates || {}; }
function wifiState() { return (S.st && S.st.wifi) || {}; }

/* ------------------------------------------------------------------ the screen: a 320 x 480 home page */
function arc(ctx, cx, cy, r, w, a0, a1, col, alpha, round) {
	ctx.beginPath();
	ctx.arc(cx, cy, r, (a0 - 90) * Math.PI / 180, (a1 - 90) * Math.PI / 180);
	ctx.lineWidth = w; ctx.lineCap = round ? 'round' : 'butt'; ctx.strokeStyle = css(col, alpha); ctx.stroke();
}
function rrect(ctx, x, y, w, h, r) { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, r); else ctx.rect(x, y, w, h); }
function font(px, bold) { return (bold ? '700 ' : '500 ') + px + 'px ' + FONT; }
function arrow(ctx, x, y, up, col) {
	ctx.beginPath();
	ctx.moveTo(x, y - 6); ctx.lineTo(x, y + 6);
	if (up) { ctx.moveTo(x - 4.5, y - 1.5); ctx.lineTo(x, y - 6); ctx.lineTo(x + 4.5, y - 1.5); }
	else { ctx.moveTo(x - 4.5, y + 1.5); ctx.lineTo(x, y + 6); ctx.lineTo(x + 4.5, y + 1.5); }
	ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = css(col); ctx.stroke();
}
function bars(ctx, x, base, h, lv, on, off) {
	var bw = h / 6;
	for (var i = 0; i < 4; i++) {
		var bh = h * (.35 + .65 * i / 3);
		rrect(ctx, x + i * bw * 2, base - bh, bw, bh, bw * .4);
		ctx.fillStyle = i < lv ? on : off; ctx.fill();
	}
	return bw * 7;
}
function batteryIcon(ctx, x, y, w, h, pct, col) {
	rrect(ctx, x, y, w, h, 3); ctx.lineWidth = 1.4; ctx.strokeStyle = css(C_TXT, 200); ctx.stroke();
	rrect(ctx, x + w + 1, y + h / 2 - 2, 2, 4, 1); ctx.fillStyle = css(C_TXT, 200); ctx.fill();
	if (pct > 0) { rrect(ctx, x + 2, y + 2, (w - 4) * Math.min(pct, 100) / 100, h - 4, 1.5); ctx.fillStyle = css(col); ctx.fill(); }
}
function bolt(ctx, x, y, s, col) {
	ctx.beginPath();
	ctx.moveTo(x + s * .55, y); ctx.lineTo(x, y + s * .58); ctx.lineTo(x + s * .42, y + s * .58);
	ctx.lineTo(x + s * .3, y + s); ctx.lineTo(x + s * .85, y + s * .42); ctx.lineTo(x + s * .45, y + s * .42); ctx.closePath();
	ctx.fillStyle = css(col); ctx.fill();
}

function drawScreen(cv) {
	var dpr = Math.min(window.devicePixelRatio || 1, 3), w = Math.round(cv.getBoundingClientRect().width * dpr);
	if (!w) return;
	var h = Math.round(w * 1.5);
	if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
	var ctx = cv.getContext('2d'), th = THEMES[S.theme] || THEMES[1], A = rgb(th.a), B = rgb(th.b), i, x;
	ctx.setTransform(w / 320, 0, 0, w / 320, 0, 0);
	ctx.clearRect(0, 0, 320, 480);
	/* the background: a glow of the accent behind the dial, falling off to near black */
	var centre = mix(rgb('#152238'), A, 26), edge = rgb('#04070D'), g = ctx.createRadialGradient(160, 190, 0, 160, 190, 330);
	for (i = 0; i <= 10; i++) g.addColorStop(i / 10, css(mix(centre, edge, Math.round(Math.min(1, i * i / 60) * 255))));
	ctx.fillStyle = g; ctx.fillRect(0, 0, 320, 480);
	if (!S.st || S.st.now == null) return;

	var b = battery(), pct = b ? b.pct : null, charging = b && b.charging;
	var bc = pct == null ? C_FAINT : pct <= 15 ? C_BAD : pct <= 30 ? C_WARN : C_OK;
	var t = new Date(Date.now() + S.skew);
	var clock = pad(t.getUTCHours()) + ':' + pad(t.getUTCMinutes());
	var conn = (cell() && cell().connected) || uplink().up, pill = linkPill(), lv = signalBars();

	/* status bar */
	ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
	ctx.fillStyle = css(C_TXT); ctx.font = font(14);
	ctx.fillText(clock, 10, 13);
	x = 310;
	batteryIcon(ctx, x - 24, 7, 20, 11, pct || 0, bc); x -= 30;
	ctx.textAlign = 'right'; ctx.fillStyle = css(C_TXT);
	var ptxt = pct != null ? pct + '%' : '--';
	ctx.fillText(ptxt, x, 13); x -= ctx.measureText(ptxt).width + 3;
	if (charging) { bolt(ctx, x - 9, 6, 13, C_OK); x -= 14; }
	x -= 22;
	bars(ctx, x, 19, 11, lv, css(C_TXT), css(C_TXT, 60));
	if (pill) { ctx.font = font(12); ctx.fillStyle = css(C_TXT); ctx.fillText(pill, x - 5, 13); }

	/* the dial: the charge as a ring around the clock */
	if (pct != null) {
		var sweep = 340 * pct / 100;
		arc(ctx, 160, 190, 130, 5, 10, 350, C_TXT, 22, true);
		if (sweep > 2) {
			arc(ctx, 160, 190, 130, 5, 10, 10 + sweep, bc, 255, true);
			if (charging) {
				var a = 10 + ((Date.now() % 2600) / 2600 * (sweep + 40)) % (sweep + 40) - 20, a0 = Math.max(a, 10), a1 = Math.min(a + 22, 10 + sweep);
				if (a1 > a0 + 1) arc(ctx, 160, 190, 130, 5, a0, a1, C_TXT, 150, true);
			}
		}
	}
	ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
	ctx.fillStyle = css(C_TXT); ctx.font = font(66, false);
	ctx.fillText(clock, 160, 158);
	ctx.fillStyle = css(C_DIM); ctx.font = font(14);
	ctx.fillText((t.getUTCMonth() + 1) + '月' + t.getUTCDate() + '日 ' + WDAY[t.getUTCDay()], 160, 184);

	/* the link: a pill (5G, or the protocol of the uplink), bars and the operator or interface */
	var ct = linkText();
	ctx.font = font(15);
	var tw = ctx.measureText(ct).width;
	ctx.font = font(12, true);
	var pw = pill ? ctx.measureText(pill).width + 14 : 0;
	x = 160 - (pw + (pw ? 7 : 0) + 22 + tw) / 2;
	if (pw) {
		rrect(ctx, x, 204, pw, 19, 9.5); ctx.fillStyle = css(pill === '5G' ? B : A); ctx.fill();
		ctx.fillStyle = css(INK); ctx.textBaseline = 'middle'; ctx.fillText(pill, x + pw / 2, 214);
		x += pw + 7;
	}
	bars(ctx, x, 222, 15, lv, css(conn ? A : C_FAINT), css(C_TXT, 55));
	ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.font = font(15); ctx.fillStyle = css(conn ? C_TXT : C_DIM);
	ctx.fillText(ct, x + 22, 220);

	var rt = rates(), r1 = fmtRate(rt.rx_bps), r2 = fmtRate(rt.tx_bps), s1 = r1[0] + ' ' + r1[1], s2 = r2[0] + ' ' + r2[1];
	ctx.font = font(15);
	var n1 = ctx.measureText(s1).width, n2 = ctx.measureText(s2).width;
	x = 160 - (14 + n1 + 18 + 14 + n2) / 2;
	arrow(ctx, x + 4, 247, false, A); x += 14;
	ctx.fillStyle = css(C_TXT); ctx.fillText(s1, x, 252); x += n1 + 18;
	arrow(ctx, x + 4, 247, true, B); x += 14;
	ctx.fillText(s2, x, 252);

	/* under the dial: Wi-Fi clients and the battery */
	var wf = wifiState(), wifiOn = !!wf.up, wc = wifiOn ? C_DIM : C_FAINT;
	for (i = 1; i <= 3; i++) arc(ctx, 100, 344, 4 * i, 1.6, -45, 45, wc, 255, false);
	ctx.beginPath(); ctx.arc(100, 344, 1.3, 0, 7); ctx.fillStyle = css(wc); ctx.fill();
	ctx.font = font(15); ctx.fillStyle = css(wifiOn ? C_TXT : C_FAINT);
	ctx.fillText((num(S.st.clients) || 0) + ' 台', 116, 344);
	batteryIcon(ctx, 166, 331, 22, 12, pct || 0, bc);
	ctx.fillStyle = css(C_TXT); ctx.fillText(pct != null ? pct + '%' : '--', 196, 344);
	if (charging) bolt(ctx, 196 + ctx.measureText(pct != null ? pct + '%' : '--').width + 4, 330, 15, C_OK);

	/* two cards: the traffic of the uplink since it came up, and the uptime */
	function card(cx, title, value) {
		rrect(ctx, cx, 366, 143, 52, 12); ctx.fillStyle = 'rgba(255,255,255,.045)'; ctx.fill();
		ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.stroke();
		ctx.textAlign = 'center';
		ctx.fillStyle = css(C_DIM); ctx.font = font(11); ctx.fillText(title, cx + 71.5, 385);
		ctx.fillStyle = css(C_TXT); ctx.font = font(13); ctx.fillText(value, cx + 71.5, 405);
	}
	card(13, '本次已用', '↓' + fmtBytes(rt.rx_total) + ' ↑' + fmtBytes(rt.tx_total));
	card(164, '已运行', fmtShort(S.st.uptime_s));

	/* page dots */
	rrect(ctx, 130, 465, 14, 4, 2); ctx.fillStyle = css(A); ctx.fill();
	for (i = 0; i < 4; i++) { ctx.beginPath(); ctx.arc(153 + i * 11, 467, 1.6, 0, 7); ctx.fillStyle = css(C_TXT, 80); ctx.fill(); }
}

/* ------------------------------------------------------------------ the front of the device */
/* MU5250 outline, 10 units per mm: the body 73 x 158 mm with rounded corners, the glass 60 x 90 mm in the upper part and the 3.5" panel
 * (49.3 x 74 mm, 320 x 480) inside it, the red power key (the only key) on the right edge, the NFC mark in the lower part, the USB-C
 * port in the bottom edge.  The screen canvas sits in the same box as the drawing (the box keeps the drawing's aspect ratio, so the
 * canvas, placed in per cent of the box, stays on the panel). */
var FIG = { h: 1664, left: 120, x: 121, y: 2, w: 730, bh: 1580, gx: 186, gy: 72, gw: 600, gh: 900, px: 240, py: 152, pw: 493, ph: 740 };
function figure(go) {
	var ns = 'http://www.w3.org/2000/svg';
	function s(tag, attrs, kids) {
		var el = document.createElementNS(ns, tag);
		for (var k in attrs) {
			if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
			else el.setAttribute(k, attrs[k]);
		}
		(kids || []).forEach(function(c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
		return el;
	}
	function layer(kids) { return s('svg', { preserveAspectRatio: 'none', 'aria-hidden': 'true' }, kids); }
	function hot(cls, label, fn, kids) {
		var g = s('g', { 'class': 'u-hot ' + cls, tabindex: '0', role: 'button', 'aria-label': label, onclick: fn,
			onkeydown: function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(); } } }, kids);
		g.appendChild(s('title', {}, [ label ]));
		return g;
	}
	var right = FIG.x + FIG.w, cx = FIG.x + FIG.w / 2, bottom = FIG.y + FIG.bh;
	var nfcIc = s('g', { 'class': 'u-nfc-ic', transform: 'translate(' + (cx - 30) + ' 1232) scale(2.5)', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7,
		'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
	nfcIc.innerHTML = (window.U60_ICONS || {}).nfc || '';
	var back = layer([
		s('rect', { 'class': 'u-body', x: FIG.x, y: FIG.y, width: FIG.w, height: FIG.bh, rx: 96 }),
		s('rect', { 'class': 'u-glass', x: FIG.gx, y: FIG.gy, width: FIG.gw, height: FIG.gh, rx: 30 }),
		nfcIc
	]);
	var front = layer([
		hot('u-hot-key', _('Power key'), function() { go('key'); }, [
			s('rect', { x: right - 20, y: 384, width: 150, height: 172, fill: 'transparent' }),
			s('rect', { 'class': 'u-hl', x: right - 4, y: 400, width: 18, height: 140, rx: 8 }),
			s('line', { 'class': 'u-lead', x1: right + 22, y1: 470, x2: right + 48, y2: 470 }),
			s('text', { 'class': 'u-lbl', x: right + 56, y: 482 }, [ _('Power key') ])
		]),
		hot('u-hot-usb', _('USB-C: charging and reverse charging'), function() { go('power'); }, [
			s('rect', { x: cx - 120, y: bottom - 44, width: 240, height: 126, fill: 'transparent' }),
			/* the port seen from the front: a slim slot in the bottom edge, marked like the key (a dashed lead to its name) */
			s('rect', { 'class': 'u-hl u-port', x: cx - 42, y: bottom - 6, width: 84, height: 12, rx: 6 }),
			s('line', { 'class': 'u-lead', x1: cx, y1: bottom + 14, x2: cx, y2: bottom + 36 }),
			s('text', { 'class': 'u-lbl', x: cx, y: bottom + 72, 'text-anchor': 'middle' }, [ 'USB-C' ])
		]),
		hot('u-hot-screen', _('Screen'), function() { go('screen'); }, [
			s('rect', { 'class': 'u-hl', x: FIG.gx + 2, y: FIG.gy + 2, width: FIG.gw - 4, height: FIG.gh - 4, rx: 28 }) ])
	]);
	front.removeAttribute('aria-hidden');
	var cv = E('canvas', { 'aria-hidden': 'true' });
	var box = E('div', { 'class': 'u-dev-box' }, [ back, cv, front ]), dev = E('div', { 'class': 'u-dev' }, [ box ]);
	/* The drawing is cut to the body's left edge and the end of the key label on the right (its width depends on the language), so the
	 * figure's box is exactly what is drawn.  The box's size goes through custom properties on the outer div. */
	function fit(r) {
		var w = r - FIG.left;
		[ back, front ].forEach(function(l) { l.setAttribute('viewBox', FIG.left + ' 0 ' + w + ' ' + FIG.h); });
		dev.style.setProperty('--fig-w', String(w));
		cv.style.left = ((FIG.px - FIG.left) / w * 100) + '%';
		cv.style.top = (FIG.py / FIG.h * 100) + '%';
		cv.style.width = (FIG.pw / w * 100) + '%';
		cv.style.height = (FIG.ph / FIG.h * 100) + '%';
	}
	function centre() {
		var r = right + 20;
		Array.prototype.forEach.call(box.querySelectorAll('.u-lbl'), function(t) {
			try { var b = t.getBBox(); if (b.width && b.x > 700 && b.x + b.width > r) r = b.x + b.width; } catch (e) {}
		});
		fit(Math.ceil(r) + 4);
	}
	fit(right + 150);
	return { el: dev, canvas: cv, centre: centre };
}

/* ------------------------------------------------------------------ switches */
function sw(onchange) {
	var inp = E('input', { 'type': 'checkbox', 'role': 'switch' });
	inp.addEventListener('change', function() {
		var want = inp.checked;
		inp.disabled = true;
		Promise.resolve(onchange(want)).then(function(r) {
			if (r && (r.error || r.ok === false)) throw new Error(r.error || _('Failed'));
		}).catch(function(e) { inp.checked = !want; fail(e); }).then(function() { inp.disabled = false; refreshSoon(); });
	});
	var el = E('label', { 'class': 'u-sw', 'click': function(ev) { ev.stopPropagation(); } }, [ inp, E('i') ]);
	el.set = function(v, dis) { if (!inp.disabled || dis != null) { if (dis != null) inp.disabled = !!dis; inp.checked = !!v; } };
	return el;
}
var refreshSoon = function() {};

return view.extend({
	load: function() {
		var p = [];
		if (!window.U60_ICONS) {
			/* another theme is active: the icons of this one */
			p.push(new Promise(function(resolve) {
				var s = document.createElement('script');
				s.src = L.resource('../u60pro/icons.js');
				s.onload = s.onerror = resolve;
				document.head.appendChild(s);
			}));
		}
		p.push(gather(), L.resolveDefault(callHw(), null), L.resolveDefault(ui.menu.load(), null));
		return Promise.all(p);
	},

	render: function(data) {
		S.st = data[data.length - 3]; S.hw = data[data.length - 2]; S.menu = data[data.length - 1];
		if (S.st) S.skew = S.st.now * 1000 - Date.now();
		var acc = num(document.documentElement.getAttribute('data-accent'));
		if (acc != null && THEMES[acc]) S.theme = acc;
		document.head.appendChild(E('link', { 'rel': 'stylesheet', 'href': L.resource('../u60pro/overview.css') + '?v=1.0-r2' }));
		var go = function(k) {
			if (S.menu && !menuHas(S.menu, LINK[k])) {
				ui.addNotification(null, E('p', APP[k] ? _('This page comes with the package luci-app-u60pro (System > Software).')
					: _('This page is not part of the installed firmware.')), 'warning');
				return;
			}
			location.href = L.url(LINK[k]);
		};
		var fig = figure(go);
		var E2 = {};
		/* every small tile has the same three rows: the header (icon, name, switch), one value, one line under it */
		function tile(cls, ic, title, extra, body, to) {
			var t = E('div', { 'class': 'u-tile ' + (cls || '') + (to ? ' tap' : ''), 'tabindex': to ? '0' : null, 'role': to ? 'link' : null }, [
				E('div', { 'class': 'u-tile-h' }, [ icon(ic), E('span', {}, [ title ]), E('span', { 'class': 'u-sp' }), extra || '' ]) ].concat(body));
			if (to) {
				t.addEventListener('click', function() { go(to); });
				t.addEventListener('keydown', function(e) { if (e.key === 'Enter' && e.target === t) go(to); });
			}
			return t;
		}
		function val() { return E('div', { 'class': 'u-val u-ellip' }); }
		function line(ic, kids) { return E('div', { 'class': 'u-meta' }, [ ic ? icon(ic) : '' ].concat(kids)); }
		E2.wifi = sw(function(on) { return on ? callWifiUp() : callWifiDown(); });
		E2.screen = sw(function(on) { return callScreen(on ? 'on' : 'off'); });
		E2.bank = sw(function(on) { return callBank(on); });
		E2.pill = E('span', { 'class': 'u-pill' });
		E2.bars = E('span', { 'class': 'u-bars' }, [ 0, 1, 2, 3 ].map(function(i) { return E('i', { 'style': 'height:%d%%'.format(35 + 65 * i / 3) }); }));
		E2.op = val(); E2.addr = E('span', { 'class': 'u-ellip u-addr' });
		E2.rx = E('b'); E2.rxu = E('small'); E2.tx = E('b'); E2.txu = E('small');
		E2.ssid = val(); E2.stations = E('span');
		E2.bat = val(); E2.batState = E('span', { 'class': 'u-ellip' }); E2.batBar = E('i');
		E2.scr = val(); E2.sleep = E('span');
		E2.bankText = val(); E2.chg = E('span');
		E2.clients = val(); E2.host = E('span');
		E2.temp = val(); E2.up = E('span');

		var view = E('div', { 'class': 'u-ov' }, [
			E('h2', {}, [ _('Overview') ]),
			E('div', { 'class': 'u-ov-grid' }, [
				E('div', { 'class': 'u-ov-hero' }, [ fig.el ]),
				E('div', { 'class': 'u-tiles' }, [
					tile('wide', 'signal', _('Network'), null, [ E('div', { 'class': 'u-net' }, [
						E('div', { 'class': 'u-net-l' }, [ E2.op, E('div', { 'class': 'u-meta' }, [ E2.pill, E2.bars, E2.addr ]) ]),
						E('div', { 'class': 'u-rates' }, [
							E('span', { 'class': 'u-rate down' }, [ icon('arrow-down'), E2.rx, E2.rxu ]),
							E('span', { 'class': 'u-rate up' }, [ icon('arrow-up'), E2.tx, E2.txu ]) ]) ]) ], 'network'),
					tile('', 'wifi', 'Wi-Fi', E2.wifi, [ E2.ssid, line('users', [ E2.stations ]) ], 'wifi'),
					tile('', 'battery', _('Battery'), null, [ E2.bat, line(null, [ E('div', { 'class': 'u-meter' }, [ E2.batBar ]), E2.batState ]) ], 'battery'),
					tile('', 'monitor', _('Screen'), E2.screen, [ E2.scr, line('moon', [ E2.sleep ]) ], 'screen'),
					tile('', 'zap', _('Reverse charging'), E2.bank, [ E2.bankText, line('plug', [ E2.chg ]) ], 'power'),
					tile('', 'users', _('Clients'), null, [ E2.clients, line('network', [ E2.host ]) ], 'clients'),
					tile('', 'cpu', _('System'), null, [ E2.temp, line('clock', [ E2.up ]) ], 'system')
				])
			])
		]);

		function update() {
			var c = cell(), u = uplink(), conn = (c && c.connected) || u.up, pill = linkPill();
			E2.pill.style.display = pill ? '' : 'none';
			txt(E2.pill, pill);
			E2.pill.className = 'u-pill' + (pill === '5G' ? ' alt' : '');
			var lv = signalBars();
			E2.bars.style.display = c ? '' : 'none';
			Array.prototype.forEach.call(E2.bars.children, function(b, i) { b.className = i < lv ? 'on' : ''; });
			txt(E2.op, conn ? linkText() : _('Not connected'));
			txt(E2.addr, u.up && u.address ? u.address : '');
			var rt = rates(), a = fmtRate(rt.rx_bps), b = fmtRate(rt.tx_bps);
			txt(E2.rx, a[0]); txt(E2.rxu, a[1]); txt(E2.tx, b[0]); txt(E2.txu, b[1]);

			var wf = wifiState(), ap = (wf.aps || [])[0];
			E2.wifi.set(wf.up, !wf.available);
			txt(E2.ssid, !wf.available ? _('No radio') : wf.up ? ((ap && ap.ssid) || 'Wi-Fi') : _('Off'));
			txt(E2.stations, wf.available ? _('%d clients').format(wf.stations || 0) : '–');

			var bt = battery();
			txt(E2.bat, bt && bt.pct != null ? bt.pct + '%' : '–');
			txt(E2.batState, batteryState(bt));
			E2.batState.className = 'u-ellip' + (bt && (bt.charging || bt.full) ? ' u-ok' : '');
			E2.batBar.style.width = ((bt && bt.pct) || 0) + '%';
			E2.batBar.className = bt && bt.pct <= 15 ? 'bad' : bt && bt.pct <= 30 ? 'warn' : '';

			var d = S.hw && S.hw.screen;
			E2.screen.set(d && d.on, !(d && d.available));
			txt(E2.scr, d && d.available ? (d.on ? _('On') : _('Off')) : '–');
			txt(E2.sleep, fmtSleep(d && d.available ? d.timeout : null));

			var pb = S.hw && S.hw.powerbank, ch = S.hw && S.hw.charger;
			E2.bank.set(pb && pb.enabled, !(pb && pb.available));
			txt(E2.bankText, pb && pb.available ? (pb.enabled ? _('On') : _('Off')) : '–');
			txt(E2.chg, !ch || !ch.available ? '–' : ch.online ? (ch.power_mw > 0 ? _('Input %s W').format((ch.power_mw / 1000).toFixed(1)) : _('External power')) : _('No charger'));

			txt(E2.clients, S.st ? _('%d clients').format(num(S.st.clients) || 0) : '–');
			txt(E2.host, (S.st && S.st.hostname) || '–');
			var tc = S.hw && S.hw.thermal && num(S.hw.thermal.soc_c);
			txt(E2.temp, tc != null ? tc.toFixed(0) + ' °C' : '–');
			txt(E2.up, fmtDur(S.st && S.st.uptime_s));
			drawScreen(fig.canvas);
		}
		this.update = update;

		function poll1() {
			return Promise.all([ gather(), L.resolveDefault(callHw(), null) ]).then(function(r) {
				if (r[0]) { S.st = r[0]; S.skew = r[0].now * 1000 - Date.now(); }
				S.hw = r[1];
				update();
			});
		}
		refreshSoon = function() { setTimeout(poll1, 900); };
		poll.add(poll1, 2);
		update();

		/* the clock: one redraw a second, more often while the charging shimmer runs */
		function loop() {
			if (!document.body.contains(fig.canvas)) return;
			var b = battery();
			drawScreen(fig.canvas);
			if (b && b.charging && !document.hidden) requestAnimationFrame(loop);
			else setTimeout(loop, 1000 - (Date.now() + S.skew) % 1000 + 20);
		}
		setTimeout(loop, 50);
		requestAnimationFrame(fig.centre);
		window.addEventListener('resize', function() { drawScreen(fig.canvas); fig.centre(); });
		return view;
	},

	handleSave: null,
	handleSaveApply: null,
	handleReset: null
});
