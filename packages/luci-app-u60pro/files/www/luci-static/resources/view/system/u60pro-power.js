'use strict';
'require view';
'require poll';
'require form';
'require u60pro.hw as hw';

/* System > Power: how the U60 Pro charges its 10 Ah battery and gives power away.  The state as tiles (with the switches that act at
 * once: pause charging for this stay on the charger, reverse charging through USB-C), and the settings as a LuCI form of u60pro.battery
 * (charge_mode, charge_stop, charge_start, long_charge_protect, low_shutdown), saved with Save & Apply; the hardware service reads them
 * again through its procd reload trigger. */
var MODES = [
	[ 'normal', _('Charge to full') ],
	[ 'limit', _('Charge limit: stop at a level, start again below another') ],
	[ 'bypass', _('Direct supply: run from the charger, never charge') ]
];

return view.extend({
	load: function() {
		return hw.status();
	},

	render: function(initial) {
		var kit = hw.kit, notice = E('div'), tiles = E('div'), st = initial || {};
		var policy = !!(st.charge || {}).policy_available;

		var pause = hw.action(function(on) {
			if (on && !window.confirm(_('Pausing stops charging until the charger is unplugged; the device keeps running from the charger. Pause?')))
				return Promise.resolve({ error: _('Cancelled') });
			return hw.call.charging(on);
		}, notice, refresh);
		var bank = hw.action(function(on) { return hw.call.powerbank(on); }, notice, refresh);

		var m = new form.Map('u60pro', _('Power'));
		var s = m.section(form.NamedSection, 'battery', 'battery', _('Charging settings'),
			policy ? _('The battery lasts longest when it is not kept full. With a charge limit the device stops charging at the upper level and runs from the charger until the battery has dropped to the lower one. Direct supply never charges while the charger is connected: for a device that stays plugged in.')
				: _('This kernel offers no charging policy control (battery_zte/ui_chg_policy_mode), so the settings below have no effect.'));
		var o = s.option(form.ListValue, 'charge_mode', _('Charging mode'));
		MODES.forEach(function(c) { o.value(c[0], c[1]); });
		o.default = 'normal';
		o = s.option(form.ListValue, 'charge_stop', _('Stop charging at'));
		[ 60, 70, 75, 80, 85, 90, 95 ].forEach(function(v) { o.value(String(v), v + '%'); });
		o.default = '80';
		o.depends('charge_mode', 'limit');
		o = s.option(form.ListValue, 'charge_start', _('Start charging again at'));
		[ 40, 50, 60, 65, 70, 75, 80, 85 ].forEach(function(v) { o.value(String(v), v + '%'); });
		o.default = '70';
		o.depends('charge_mode', 'limit');
		o.validate = function(section_id, v) {
			var stop = this.map.lookupOption('charge_stop', section_id);
			stop = stop && stop[0] ? +stop[0].formvalue(section_id) : 100;
			return +v < stop ? true : _('The level to start charging again must be below the level to stop at.');
		};

		s = m.section(form.NamedSection, 'battery', 'battery', _('Protection'));
		o = s.option(form.Flag, 'long_charge_protect', _('Long-charge protection'),
			_('The battery driver\'s own protection: after 16 hours on the charger at 100 % it holds the battery near 80 %. Switched off, the battery stays full for as long as the charger is connected.'));
		o.default = '1';
		o.rmempty = false;
		o = s.option(form.ListValue, 'low_shutdown', _('Switch off on low battery'),
			_('Shuts the system down cleanly at this charge while running on battery. Without it the power management chip cuts the power when the battery is empty.'));
		o.value('0', _('Off (leave it to the hardware)'));
		[ 1, 2, 3, 5, 8, 10 ].forEach(function(v) { o.value(String(v), v + '%'); });
		o.default = '0';

		function apply(c) {
			st = c;
			if (c.error) { hw.note(notice, c.error, true); tiles.replaceChildren(); return; }
			var b = c.battery || {}, ch = c.charger || {}, g = c.charge || {}, pb = c.powerbank || {}, lp = g.long_protect || {};
			pause.set(g.paused, !g.policy_available || !ch.online);
			bank.set(pb.enabled, !pb.available);
			var mode = MODES.filter(function(x) { return x[0] === g.mode; })[0];
			tiles.replaceChildren(kit.tiles([
				{ icon: ch.online ? 'battery-charging' : 'battery', label: _('Battery'), value: b.capacity, unit: '%',
					meter: b.capacity, meterTone: kit.tone(b.capacity, 30, 15) },
				{ icon: 'plug', label: _('Charger'), value: ch.online ? (ch.power_mw > 0 ? (ch.power_mw / 1000).toFixed(1) + ' W' : _('Connected')) : _('Not connected'),
					meta: ch.online ? [ ch.type, ch.voltage_mv != null ? (ch.voltage_mv / 1000).toFixed(1) + ' V' : null ].filter(Boolean).join(' · ') : hw.batteryState(c) },
				{ icon: 'zap', label: _('Pause charging'), value: g.holding ? _('Not charging') : (b.status === 'Charging' ? _('Charging') : hw.batteryState(c)),
					chip: pause.el, tone: g.holding ? 'warn' : '',
					meta: g.mode === 'limit' ? _('Limit %d%% / %d%%').format(g.stop, g.start) : (g.mode === 'bypass' ? _('Direct supply') : _('Charge to full')) },
				{ icon: 'usb', label: _('Reverse charging'), value: pb.available ? (pb.enabled ? _('On') : _('Off')) : _('Not available'),
					chip: bank.el, meta: pb.available ? (pb.present ? _('A device is drawing power') : _('USB-C gives up to 18 W')) : _('Not offered by this kernel') },
				{ icon: 'shield-check', label: _('Long-charge protection'),
					value: !lp.supported ? _('Not available') : lp.active ? _('Holding at 80%') : (lp.enabled ? _('Armed') : _('Off')),
					tone: lp.active ? 'accent' : '', meta: lp.supported && lp.threshold_min ? _('After %s at 100%%').format(hw.span(lp.threshold_min * 60)) : null },
				{ icon: 'power', label: _('Low battery'), value: g.low_shutdown > 0 ? g.low_shutdown + '%' : _('Off'),
					meta: g.low_shutdown > 0 ? _('Clean shutdown on battery') : _('Hardware cut-off only') }
			]));
		}

		function refresh() {
			return hw.status().then(apply);
		}

		apply(st);
		poll.add(refresh, 5);
		return kit.formPage(m, [ notice, tiles ], [ 'battery-charging', 'shield' ]);
	}
});
