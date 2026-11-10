'use strict';
'require view';
'require poll';
'require form';
'require u60pro.hw as hw';

/* System > Screen: the 3.5" 320x480 touch screen of the U60 Pro.  Its backlight (an AW9523 LED driver, /sys/class/leds/led:lcd) has a
 * real brightness, unlike the U30 Pro's.  The state as tiles with the power switch, a brightness slider that acts at once, and the
 * settings as a LuCI form of u60pro.screen (brightness, timeout, dim, wake_touch, wake_power, manager, ui_process), saved with Save &
 * Apply.  When a screen program (zwrt-devui) runs it owns the backlight and the power key, and this page shows that. */
var SLEEP_CHOICES = [ [ '15', _('15 seconds') ], [ '30', _('30 seconds') ], [ '60', _('1 minute') ], [ '120', _('2 minutes') ], [ '300', _('5 minutes') ],
	[ '600', _('10 minutes') ], [ '0', _('Never (always on)') ] ];
var MANAGERS = [
	[ 'auto', _('Automatic') ],
	[ 'hwd', _('Hardware service') ],
	[ 'external', _('Screen program') ]
];

return view.extend({
	load: function() {
		return hw.status();
	},

	render: function(initial) {
		var kit = hw.kit, notice = E('div'), tiles = E('div'), st = initial || {}, sliding = false;
		var power = hw.action(function(on) { return hw.call.screenPower(on ? 'on' : 'off'); }, notice, refresh);
		var range = E('input', { 'type': 'range', 'min': '1', 'max': '100', 'step': '1', 'class': 'k-range' });
		var rangeText = E('span', { 'class': 'k-range-v' });
		var timer = null;
		range.addEventListener('input', function() {
			sliding = true;
			rangeText.textContent = range.value + '%';
			/* the screen follows the slider as it moves (at most ten writes a second) */
			if (timer) return;
			timer = setTimeout(function() {
				timer = null;
				hw.call.brightness(+range.value).catch(function() {});
			}, 100);
		});
		range.addEventListener('change', function() {
			hw.call.brightness(+range.value).then(function(r) {
				var bad = hw.failure(r);
				if (bad) hw.note(notice, bad, true);
			}).catch(function() {}).then(function() { sliding = false; });
		});

		var m = new form.Map('u60pro', _('Screen'));
		var s = m.section(form.NamedSection, 'screen', 'screen', _('Screen settings'),
			_('The brightness set here is the one the screen starts with; the slider above changes it at once without saving.'));
		var o = s.option(form.Value, 'brightness', _('Brightness (%)'));
		o.datatype = 'range(1,100)';
		o.default = '70';
		o = s.option(form.ListValue, 'timeout', _('Switch the screen off after'), _('Counted from the last touch or key press.'));
		SLEEP_CHOICES.forEach(function(c) { o.value(c[0], c[1]); });
		o.default = '60';
		o = s.option(form.Flag, 'dim', _('Dim before switching off'), _('The last 5 seconds are shown at a third of the brightness.'));
		o.default = '1';
		o.rmempty = false;
		o = s.option(form.Flag, 'wake_touch', _('A touch wakes the screen'), _('Off: only the power key switches a dark screen on.'));
		o.default = '1';
		o.rmempty = false;
		o = s.option(form.Flag, 'wake_power', _('Wake when the charger is plugged in or out'));
		o.default = '1';
		o.rmempty = false;

		s = m.section(form.NamedSection, 'screen', 'screen', _('Screen program'),
			_('A program that draws on the screen (zwrt-devui) handles the backlight, the touch screen and the power key itself. While it runs, the hardware service only watches.'));
		o = s.option(form.ListValue, 'manager', _('Backlight and power key are run by'),
			_('Automatic: the screen program while it runs, otherwise the hardware service.'));
		MANAGERS.forEach(function(c) { o.value(c[0], c[1]); });
		o.default = 'auto';
		o = s.option(form.Value, 'ui_process', _('Name of the screen program'));
		o.default = 'zwrt-devui';
		o.datatype = 'maxlength(32)';
		o.depends('manager', 'auto');

		function apply(c) {
			st = c;
			if (c.error) { hw.note(notice, c.error, true); tiles.replaceChildren(); return; }
			var d = c.screen || {}, ours = d.manager === 'hwd';
			var touch = ((c.keys || {}).devices || []).filter(function(x) { return x.touch; })[0];
			power.set(d.on, !d.available || !ours);
			range.disabled = !d.available || !ours;
			if (!sliding) {
				range.value = d.brightness != null ? d.brightness : 70;
				rangeText.textContent = range.value + '%';
			}
			var sleep = SLEEP_CHOICES.filter(function(x) { return x[0] === String(d.timeout); })[0];
			tiles.replaceChildren(kit.tiles([
				{ icon: 'monitor', label: _('Screen'), value: !d.available ? _('No backlight') : d.on ? (d.dimmed ? _('Dimmed') : _('On')) : _('Off'), chip: power.el,
					meta: sleep ? _('Sleeps after %s').format(sleep[1]) : null },
				{ icon: 'sun', label: _('Backlight'), value: d.level != null ? Math.round(d.level * 100 / (d.max || 255)) : null, unit: '%',
					meter: d.level != null ? d.level * 100 / (d.max || 255) : 0, meterTone: '' },
				{ icon: 'hand', label: _('Touch panel'), value: touch ? _('Ready') : _('Not reported'),
					meta: d.idle_s != null ? _('Last touch or key %s ago').format(d.idle_s < 60 ? _('%d s').format(d.idle_s) : hw.span(d.idle_s)) : null },
				{ icon: 'smartphone', label: _('Run by'), value: ours ? _('Hardware service') : _('Screen program'),
					chip: d.ui_running ? kit.chip(d.ui_process, 'ok') : null, meta: d.resolution ? d.resolution.replace('x', ' × ') + ' · 3.5″' : null }
			]));
		}

		function refresh() {
			return hw.status().then(apply);
		}

		apply(st);
		poll.add(refresh, 3);
		return kit.formPage(m, [ notice, tiles,
			kit.card({ title: _('Brightness'), icon: 'sun', body: [
				E('div', { 'class': 'k-range-row' }, [ kit.icon('moon'), range, kit.icon('sun'), rangeText ])
			], help: _('Applies at once and lasts until the next change or restart; Save & Apply below keeps a brightness for good.') })
		], [ 'sliders-horizontal', 'smartphone' ]);
	}
});
