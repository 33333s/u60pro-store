'use strict';
'require view';
'require poll';
'require form';
'require rpc';
'require uci';
'require u60pro.hw as hw';

/* Network > Wi-Fi: the two radios of the U60 Pro (WCN7850, Wi-Fi 7).  They are run by the device's own wireless service (the QCA
 * hostapd that netifd's wireless scripts cannot drive), so this page stands in for LuCI's Wireless page: the state as tiles with the
 * main switch and one switch per radio, the radio combination (which bands the two radios serve, or both joined into one 320 MHz
 * channel on 6 GHz) as one row of buttons that switch at once, and the name, password and channels as a LuCI form of the UCI config
 * u60wifi, saved with Save & Apply (the service reloads on the change).
 *
 * ubus u60pro.wifi: status -> {enabled, up, mode, modes[], ssid, key, encryption, country, radios[{name, disabled, up, ifname,
 * band, width, channel, ssid, encryption, stations}]}; set {mode | enabled | ...}; radio {name, disabled}. */
var callStatus = rpc.declare({ object: 'u60pro.wifi', method: 'status' });
var callMode = rpc.declare({ object: 'u60pro.wifi', method: 'set', params: [ 'mode' ] });
var callEnable = rpc.declare({ object: 'u60pro.wifi', method: 'set', params: [ 'enabled' ] });
var callRadio = rpc.declare({ object: 'u60pro.wifi', method: 'radio', params: [ 'name', 'disabled' ] });

/* the combinations by the names the service uses; one it reports and this page does not know is shown by its name */
var MODES = { '2g+5g': '2.4G + 5G', '5g': '5G', '5g+6g': '5G + 6G', '6g': '6G 320M', '5g+5g': '5G + 5G', '2g': '2.4G' };
var BAND = { '2g': '2.4 GHz', '5g': '5 GHz', '5gl': _('5 GHz low'), '5gh': _('5 GHz high'), '6g': '6 GHz' };
var ENC = [ [ 'sae', 'WPA3' ], [ 'sae-mixed', 'WPA2 / WPA3' ], [ 'psk2', 'WPA2' ] ];

return view.extend({
	load: function() {
		return Promise.all([
			L.resolveDefault(callStatus(), null),
			L.resolveDefault(uci.load('u60wifi'), null)
		]);
	},

	render: function(data) {
		var kit = hw.kit, notice = E('div'), tiles = E('div'), st = data[0] || {};
		var have = Array.isArray(st.radios), haveConfig = uci.sections('u60wifi').length > 0;
		var main = hw.action(function(on) { return callEnable(on); }, notice, refresh);
		var radioSw = {}, seg = null, segBox = E('div'), switching = false;

		function radioSwitch(name) {
			if (!radioSw[name])
				radioSw[name] = hw.action(function(on) { return callRadio(name, !on); }, notice, refresh);
			return radioSw[name];
		}

		/* one button per combination; a click switches */
		function drawModes() {
			var names = (st.modes || []).slice();
			if (st.mode && st.mode !== 'custom' && names.indexOf(st.mode) < 0) names.unshift(st.mode);
			if (!seg || seg.names !== names.join(' ')) {
				seg = kit.seg(names.map(function(n) { return [ n, MODES[n] || n ]; }), st.mode || '');
				seg.names = names.join(' ');
				seg.el.classList.add('k-seg-row');
				seg.onchange = function(want) {
					switching = true;
					seg.disable(true);
					hw.note(notice, null);
					callMode(want).then(function(r) {
						var bad = hw.failure(r);
						if (bad) hw.note(notice, bad, true);
					}).catch(function(e) { hw.note(notice, (e && e.message) || String(e), true); }).then(function() {
						switching = false;
						seg.disable(false);
						return refresh();
					});
				};
				segBox.replaceChildren(seg.el);
			}
			if (!switching) seg.set(st.mode || '');
		}

		function draw() {
			var radios = st.radios || [], total = 0;
			radios.forEach(function(r) { if (r.up && r.stations) total += r.stations; });
			main.set(st.up != null ? st.up : st.enabled, !have);
			var list = [ { icon: 'wifi', label: 'Wi-Fi', value: !have ? null : st.up ? _('On') : (st.enabled ? _('Starting') : _('Off')), chip: main.el,
				meta: have ? (MODES[st.mode] || (st.mode === 'custom' ? _('Own combination') : st.mode)) : null } ];
			radios.forEach(function(r, i) {
				var s = radioSwitch(r.name);
				s.set(!r.disabled, !st.enabled);
				list.push({ icon: 'radio-tower', label: _('Radio %d').format(i + 1), chip: s.el,
					value: r.disabled ? _('Off') : (BAND[r.band] || r.band), tone: r.disabled ? 'dim' : '',
					unit: !r.disabled && r.width ? r.width + ' MHz' : null,
					meta: r.disabled ? null : !r.up ? _('Starting')
						: [ r.channel ? _('Channel %d').format(r.channel) : null, _('%d clients').format(r.stations || 0) ].filter(Boolean).join(' · ') });
			});
			list.push({ icon: 'smartphone', label: _('Clients'), value: have ? total : null,
				meta: st.encryption ? (ENC.filter(function(e) { return e[0] === st.encryption; })[0] || [ 0, st.encryption ])[1] : null });
			tiles.replaceChildren(kit.tiles(list));
			drawModes();
		}

		function refresh() {
			return L.resolveDefault(callStatus(), null).then(function(r) {
				if (r && Array.isArray(r.radios)) { st = r; have = true; }
				draw();
			});
		}

		/* without the service or its settings there is nothing to edit: say so (and show the state, when there is one) */
		if (!have || !haveConfig) {
			if (have) draw();
			return kit.page('Wi-Fi', null, [
				E('div', { 'class': 'alert-message warning' }, !have
					? _('The wireless service of this device is not running (ubus object u60pro.wifi).')
					: _('The wireless service has no settings yet (/etc/config/u60wifi).')),
				have ? tiles : '' ]);
		}

		var m = new form.Map('u60wifi', 'Wi-Fi');
		var s = m.section(form.NamedSection, 'main', 'wifi', _('Name and password'));
		var o = s.option(form.Value, 'ssid', _('Name'));
		o.datatype = 'and(minlength(1),maxlength(32))';
		o.rmempty = false;
		o = s.option(form.Value, 'key', _('Password'));
		o.password = true;
		o.datatype = 'wpakey';
		o.rmempty = false;
		o = s.option(form.ListValue, 'encryption', _('Security'));
		ENC.forEach(function(c) { o.value(c[0], c[1]); });
		o.default = 'sae-mixed';
		o = s.option(form.Value, 'country', _('Country code'));
		o.datatype = 'and(minlength(2),maxlength(2))';
		o.rmempty = false;

		[ 'radio0', 'radio1' ].forEach(function(name, i) {
			if (!uci.get('u60wifi', name)) return;
			s = m.section(form.NamedSection, name, 'radio', _('Radio %d').format(i + 1));
			o = s.option(form.Value, 'channel', _('Channel'));
			o.datatype = 'range(1,233)';
			o.placeholder = _('automatic');
			o.rmempty = true;
			o = s.option(form.Value, 'ssid', _('Own name'));
			o.datatype = 'maxlength(32)';
			o.placeholder = _('same as above');
			o.rmempty = true;
		});

		draw();
		poll.add(refresh, 3);
		return kit.formPage(m, [ notice, tiles,
			kit.card({ title: _('Radio combination'), icon: 'radio-tower', body: [ segBox ] })
		], [ 'lock', 'radio-tower', 'radio-tower' ]);
	}
});
