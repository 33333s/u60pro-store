'use strict';
'require view';
'require poll';
'require u60pro.hw as hw';

/* Status > Battery: the battery of the U60 Pro (3.91 V, 10 Ah) as tiles, the history the hardware service keeps in memory since it
 * started (one sample a minute, up to two days) as two charts on one time axis: the charge (charger periods shaded) and the power
 * through the battery; a pointer over them reads one sample.  Under them the readings of the fuel gauge and of the charger input.
 * The settings (charge limit, direct supply, reverse charging) are System > Power. */
var W = 1000;
var RANGES = [ [ '60', _('1 hour') ], [ '360', _('6 hours') ], [ '1440', _('24 hours') ], [ '2880', _('48 hours') ] ];
var STATES = { D: _('On battery'), C: _('Charging'), F: _('Full, on the charger'), P: _('On the charger, not charging') };
var LEVEL = 'var(--k-accent, #3b82f6)', DRAIN = 'var(--k-accent-2, #e85d9a)', CHARGE = 'color-mix(in srgb, var(--k-ok, #4ade80) 20%, transparent)',
	GAIN = 'var(--k-ok, #4ade80)', PLUGGED = 'rgba(136,136,136,.16)', GRID = 'var(--k-line, rgba(136,136,136,.25))';

function pad(n) { return (n < 10 ? '0' : '') + n; }
function when(t) {
	var d = new Date(t * 1000);
	return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function scaleOf(peak) {
	var steps = [ 1000, 2000, 3000, 5000, 8000, 10000, 15000, 20000, 30000 ];
	for (var i = 0; i < steps.length; i++) if (peak <= steps[i]) return steps[i];
	return Math.ceil(peak / 10000) * 10000;
}

/* the samples [t, pct, state, mw, temp] put on a grid of `n` steps over the range (a step without a sample is null) */
function grid(samples, t0, t1, n) {
	var g = { pct: [], st: [], mw: [], n: n, t0: t0, step: (t1 - t0) / (n - 1) }, i;
	for (i = 0; i < n; i++) { g.pct.push(null); g.st.push(null); g.mw.push(null); }
	samples.forEach(function(s) {
		var k = Math.round((s[0] - t0) / g.step);
		if (k < 0 || k >= n) return;
		g.pct[k] = s[1]; g.st[k] = s[2]; g.mw[k] = s[3];
	});
	return g;
}

function levelSvg(g, H) {
	var n = g.n, x = function(i) { return i * W / (n - 1); }, y = function(v) { return H - v * H / 100; };
	var bands = [], paths = [], seg = [], bw = W / (n - 1);
	function flush() {
		if (seg.length > 1) {
			var line = seg.map(function(p, k) { return (k ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('');
			paths.push('<path d="' + line + 'L' + seg[seg.length - 1][0].toFixed(1) + ' ' + H + 'L' + seg[0][0].toFixed(1) + ' ' + H + 'Z" style="fill:' + LEVEL + ';fill-opacity:.14"/>');
			paths.push('<path d="' + line + '" style="fill:none;stroke:' + LEVEL + '" stroke-width="2.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>');
		} else if (seg.length == 1)
			paths.push('<circle cx="' + seg[0][0] + '" cy="' + seg[0][1] + '" r="3" style="fill:' + LEVEL + '"/>');
		seg = [];
	}
	for (var i = 0; i < n; i++) {
		var st = g.st[i];
		if (st == 'C' || st == 'F' || st == 'P')
			bands.push('<rect x="' + Math.max(0, x(i) - bw / 2).toFixed(1) + '" y="0" width="' + bw.toFixed(1) + '" height="' + H + '" style="fill:' + (st == 'P' ? PLUGGED : CHARGE) + '"/>');
		if (g.pct[i] == null) { flush(); continue; }
		seg.push([ x(i), y(g.pct[i]) ]);
	}
	flush();
	var lines = [ 25, 50, 75 ].map(function(v) { return '<line x1="0" x2="' + W + '" y1="' + y(v) + '" y2="' + y(v) + '" style="stroke:' + GRID + '" vector-effect="non-scaling-stroke"/>'; });
	return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:' + H + 'px;display:block">' +
		bands.join('') + lines.join('') + paths.join('') + '</svg>';
}

/* the power through the battery as bars from a middle line: charging up (green), drawing down */
function powerSvg(g, H, scale) {
	var n = g.n, bw = W / n, bars = [], mid = H / 2;
	for (var i = 0; i < n; i++) {
		if (g.mw[i] == null || g.mw[i] == 0) continue;
		var v = Math.min(Math.abs(g.mw[i]) / scale, 1) * mid, up = g.mw[i] > 0;
		bars.push('<rect x="' + (i * bw).toFixed(1) + '" y="' + (up ? mid - v : mid).toFixed(1) + '" width="' + Math.max(bw * .8, 1).toFixed(1) + '" height="' + v.toFixed(1) +
			'" rx="1.5" style="fill:' + (up ? GAIN : DRAIN) + '"/>');
	}
	return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="width:100%;height:' + H + 'px;display:block">' +
		'<line x1="0" x2="' + W + '" y1="' + mid + '" y2="' + mid + '" style="stroke:' + GRID + '" vector-effect="non-scaling-stroke"/>' + bars.join('') + '</svg>';
}

function axisLabel(text, side, bottom) {
	return E('div', { 'class': 'k-chart-l', 'style': side + ':6px' + (bottom ? ';top:auto;bottom:4px' : '') }, text);
}

return view.extend({
	range: '360',

	load: function() {
		return Promise.all([ hw.status(), L.resolveDefault(hw.call.history(+this.range), null) ]);
	},

	render: function(data) {
		var self = this, kit = hw.kit, notice = E('div'), tiles = E('div'), body = E('div'), details = E('div'), charger = E('div');

		function drawState(st) {
			if (st.error) { hw.note(notice, st.error, true); return; }
			hw.note(notice, null);
			var b = st.battery || {}, c = st.charger || {}, g = st.charge || {};
			var left = b.status === 'Charging' ? b.time_to_full_s : b.time_to_empty_s;
			tiles.replaceChildren(kit.tiles([
				{ icon: c.online ? 'battery-charging' : 'battery', label: _('Charge now'), value: b.capacity, unit: '%',
					meter: b.capacity, meterTone: kit.tone(b.capacity, 30, 15) },
				{ icon: 'plug', label: _('State'), value: hw.batteryState(st),
					meta: _('Battery power now %s').format(hw.watts(b.power_mw, true)) },
				{ icon: 'timer', label: b.status === 'Charging' ? _('Time to full') : _('Estimated time left'), value: left > 0 ? hw.span(left) : null,
					meta: b.drain_per_hour != null ? _('Drain rate %s').format(b.drain_per_hour.toFixed(1) + ' %/h') : (g.mode === 'limit' ? _('Charges up to %d%%').format(g.stop) : null) },
				{ icon: 'thermometer', label: _('Battery temperature'), value: b.temp_c != null ? b.temp_c.toFixed(1) : null, unit: '°C',
					tone: b.temp_c >= 50 ? 'bad' : b.temp_c >= 45 ? 'warn' : '', meta: b.health ? _('Health: %s').format(b.health) : null }
			]));
			var wear = b.charge_full_mah && b.design_mah ? Math.round(b.charge_full_mah * 100 / b.design_mah) : null;
			details.replaceChildren(kit.kv([
				[ _('Voltage'), b.voltage_mv != null ? (b.voltage_mv / 1000).toFixed(3) + ' V' : null ],
				[ _('Current'), b.current_ma != null ? (b.current_ma > 0 ? '+' : '') + b.current_ma + ' mA' : null ],
				[ _('Design capacity'), b.design_mah != null ? b.design_mah + ' mAh' : null ],
				[ _('Full charge capacity'), b.charge_full_mah != null ? b.charge_full_mah + ' mAh' + (wear != null ? ' (' + wear + '%)' : '') : null ],
				[ _('Charge cycles'), b.cycles ],
				[ _('Charging policy'), g.policy_available ? (g.holding ? kit.chip(_('Not charging (held)'), 'warn') : kit.chip(_('Charging allowed'), 'ok')) : _('Not offered by this kernel') ]
			]));
			charger.replaceChildren(kit.kv([
				[ _('Charger'), c.available ? (c.online ? kit.chip(_('Connected'), 'ok') : kit.chip(_('Not connected'))) : _('Not reported') ],
				[ _('Type'), c.online ? c.type : null ],
				[ _('Input voltage'), c.online && c.voltage_mv != null ? (c.voltage_mv / 1000).toFixed(2) + ' V' : null ],
				[ _('Input current'), c.online && c.current_ma != null ? c.current_ma + ' mA' : null ],
				[ _('Input power'), c.online ? hw.watts(c.power_mw) : null ],
				[ _('Reverse charging'), st.powerbank && st.powerbank.available ? (st.powerbank.enabled ? kit.chip(_('On'), 'accent') : kit.chip(_('Off'))) : _('Not offered by this kernel') ]
			]));
		}

		function drawHistory(h) {
			var samples = (h && h.samples) || [];
			if (!samples.length) {
				body.replaceChildren(E('p', { 'class': 'cbi-value-description' }, _('No samples yet: one is taken every minute while the hardware service runs.')));
				return;
			}
			var minutes = +self.range, t1 = Math.floor(Date.now() / 1000), t0 = t1 - minutes * 60;
			var n = Math.min(minutes + 1, 289), g = grid(samples, t0, t1, n), peak = 0;
			g.mw.forEach(function(v) { if (v != null && Math.abs(v) > peak) peak = Math.abs(v); });
			var scale = scaleOf(peak);
			var readout = E('div', { 'class': 'k-chart-read' }, _('Point at the charts to read a moment.'));
			var marker = E('div', { 'class': 'k-chart-mark', 'style': 'display:none' });
			var level = E('div', { 'class': 'k-chart' }), power = E('div', { 'class': 'k-chart', 'style': 'margin-top:8px' });
			level.innerHTML = levelSvg(g, 180);
			power.innerHTML = powerSvg(g, 100, scale);
			level.appendChild(axisLabel('100%', 'left'));
			level.appendChild(axisLabel(_('Charge'), 'right'));
			power.appendChild(axisLabel('+' + (scale / 1000) + ' W', 'left'));
			power.appendChild(axisLabel('−' + (scale / 1000) + ' W', 'left', true));
			power.appendChild(axisLabel(_('Power into (up) and out of the battery'), 'right'));
			var charts = E('div', { 'class': 'k-charts' }, [ level, power, marker ]);
			charts.addEventListener('mousemove', function(ev) {
				var r = charts.getBoundingClientRect(), f = (ev.clientX - r.left) / r.width;
				if (f < 0 || f > 1) return;
				var i = Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))));
				marker.style.display = '';
				marker.style.left = (i / (n - 1) * 100) + '%';
				var t = g.t0 + i * g.step;
				readout.textContent = g.pct[i] == null ? when(t) + ' · ' + _('no sample') :
					[ when(t), g.pct[i] + '%', STATES[g.st[i]] || '', g.mw[i] != null ? hw.watts(g.mw[i], true) : '' ].filter(function(v) { return v; }).join(' · ');
			});
			charts.addEventListener('mouseleave', function() { marker.style.display = 'none'; });
			var ticks = [];
			for (var k = 0; k <= 4; k++) ticks.push(E('span', {}, k == 4 ? _('now') : when(t0 + (t1 - t0) * k / 4)));
			body.replaceChildren(readout, charts, E('div', { 'class': 'k-chart-axis' }, ticks),
				E('div', { 'class': 'k-legend' }, [
					E('span', {}, [ E('i', { 'style': 'background:' + CHARGE }), _('Charging or full') ]),
					E('span', {}, [ E('i', { 'style': 'background:' + PLUGGED }), _('On the charger, not charging') ]),
					E('span', {}, [ E('i', { 'style': 'background:' + GAIN }), _('Power into the battery') ]),
					E('span', {}, [ E('i', { 'style': 'background:' + DRAIN }), _('Power drawn from the battery') ])
				]));
		}

		var seg = kit.seg(RANGES, self.range);
		seg.onchange = function(v) {
			self.range = v;
			L.resolveDefault(hw.call.history(+v), null).then(drawHistory);
		};
		drawState(data[0]);
		drawHistory(data[1]);
		poll.add(function() { return hw.status().then(drawState); }, 5);
		poll.add(function() { return L.resolveDefault(hw.call.history(+self.range), null).then(drawHistory); }, 60);

		return kit.page(_('Battery'), null, [
			notice, tiles,
			kit.card({ title: _('History'), icon: 'activity', actions: seg.el, body: body,
				help: _('One sample a minute, kept in memory for two days; the history starts again when the device restarts.') }),
			kit.card({ title: _('Battery'), icon: 'battery', body: details }),
			kit.card({ title: _('Charger and USB-C'), icon: 'plug', body: charger,
				help: _('The charge limit, direct supply and reverse charging are set in System > Power.') })
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
