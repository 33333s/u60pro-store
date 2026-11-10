'use strict';
'require view';
'require poll';
'require form';
'require u60pro.hw as hw';

/* System > Buttons: the U60 Pro has one key, the red power key on its right edge (KEY_POWER).  What a short, a double and a long press
 * do is a LuCI form of u60pro.power (short, double, long, long_ms and a command each), saved with Save & Apply; the hardware service
 * reads it again through its procd reload trigger.  Above it the key's state as tiles and the presses the service has seen, which is
 * also how to check that the key reaches the system at all.  A hold of about ten seconds is the hardware's own forced power-off and
 * cannot be changed here. */
var ACTIONS = [
	[ 'none', _('No action') ],
	[ 'screen_toggle', _('Switch the screen on or off') ],
	[ 'screen_off', _('Switch the screen off') ],
	[ 'wifi_toggle', _('Toggle Wi-Fi') ],
	[ 'data_toggle', _('Toggle the mobile data connection') ],
	[ 'powerbank_toggle', _('Toggle reverse charging') ],
	[ 'reboot', _('Restart') ],
	[ 'poweroff', _('Power off') ],
	[ 'command', _('Run a command') ]
];
var RAN = { external: _('left to the screen program'), screen_on: _('lit the screen') };
var GESTURES = { 'short': _('Short press'), 'double': _('Double press'), 'long': _('Long press') };
var PRESS_TIMES = [ 1000, 1500, 2000, 3000, 4000, 5000 ];

function label(v) {
	var m = ACTIONS.filter(function(a) { return a[0] === v; })[0];
	return m ? m[1] : (RAN[v] || v);
}
function pad(n) { return (n < 10 ? '0' : '') + n; }
function clock(t) {
	var d = new Date(t * 1000);
	return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

return view.extend({
	load: function() {
		return hw.status();
	},

	render: function(initial) {
		var kit = hw.kit, notice = E('div'), tiles = E('div'), events = E('div');

		var m = new form.Map('u60pro', _('Buttons'));
		var s = m.section(form.NamedSection, 'power', 'key', _('Power key'),
			_('A short press on a dark screen always lights it first. With a double-press action set, a single press acts a third of a second later, once it is clear that no second press follows. While a screen program runs, it handles the key itself and these actions rest.'));
		function action(name, title, def, descr) {
			var o = s.option(form.ListValue, name, title, descr);
			ACTIONS.forEach(function(a) { o.value(a[0], a[1]); });
			o.default = def;
			var c = s.option(form.Value, 'command_' + name, _('Command'), _('Run by /bin/sh as root, in the background.'));
			c.depends(name, 'command');
			c.rmempty = true;
			c.validate = function(section_id, v) { return v === '' ? _('Enter the command to run.') : true; };
		}
		action('short', _('Short press'), 'screen_toggle');
		action('double', _('Double press'), 'none');
		action('long', _('Long press'), 'poweroff');
		var o = s.option(form.ListValue, 'long_ms', _('Long-press trigger time'));
		PRESS_TIMES.forEach(function(ms) { o.value(String(ms), _('%s s').format(ms / 1000)); });
		o.default = '3000';

		function apply(c) {
			if (c.error) { hw.note(notice, c.error, true); tiles.replaceChildren(); events.replaceChildren(); return; }
			var k = c.keys || {}, cfg = (k.config || []).filter(function(x) { return x.code === 116; })[0] || {}, last = (k.log || [])[0];
			var ours = (c.screen || {}).manager === 'hwd';
			var dev = (k.devices || []).filter(function(x) { return !x.touch; }).map(function(x) { return x.name; }).join(', ');
			tiles.replaceChildren(kit.tiles([
				{ icon: 'keyboard', label: _('Key input'), value: k.ready ? _('Listening') : _('No input'),
					chip: k.ready ? kit.chip(ours ? _('Ready') : _('Screen program'), ours ? 'ok' : 'accent') : kit.chip(_('Off'), 'warn'),
					meta: dev || _('KEY_POWER (code %s)').format(116) },
				{ icon: 'activity', label: _('Presses seen'), value: k.count,
					meta: last ? _('Last: %s at %s').format(GESTURES[last.gesture] || last.gesture, clock(last.t)) : _('None yet') },
				{ icon: 'hand', label: _('Short press'), value: label(cfg.short || 'none'),
					meta: cfg.double && cfg.double !== 'none' ? _('Double: %s').format(label(cfg.double)) : null },
				{ icon: 'timer', label: _('Long press'), value: label(cfg.long || 'none'),
					meta: _('After %s').format(_('%s s').format((cfg.long_ms || 3000) / 1000)) }
			]));
			if (!k.ready)
				hw.note(notice, _('The kernel reports no input devices: key presses cannot reach the system.'), true);
			else
				hw.note(notice, null);
			var rows = (k.log || []).map(function(e) {
				return E('tr', { 'class': 'tr' }, [ E('td', { 'class': 'td' }, clock(e.t)), E('td', { 'class': 'td' }, e.name + ' (' + e.code + ')'),
					E('td', { 'class': 'td' }, GESTURES[e.gesture] || e.gesture), E('td', { 'class': 'td' }, label(e.action)) ]);
			});
			events.replaceChildren(rows.length ? E('div', { 'class': 'k-scroll' }, E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [ E('th', { 'class': 'th' }, _('Time')), E('th', { 'class': 'th' }, _('Key')),
					E('th', { 'class': 'th' }, _('Press')), E('th', { 'class': 'th' }, _('What it did')) ]) ].concat(rows)))
				: E('p', { 'class': 'cbi-value-description' }, _('Press the power key: every press the service sees is listed here.')));
		}

		apply(initial || {});
		poll.add(function() { return hw.status().then(apply); }, 2);

		return kit.formPage(m, [ notice, tiles ], [ 'power' ], [
			kit.card({ title: _('Recent presses'), icon: 'list', body: events,
				help: _('Holding the key for about ten seconds forces the power off in hardware, whatever is set here.') })
		]);
	}
});
