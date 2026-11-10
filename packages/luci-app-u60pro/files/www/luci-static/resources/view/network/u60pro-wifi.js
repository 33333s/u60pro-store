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
 * channel on 6 GHz) as a choice that is applied with its own button, and the name, password and channels as a LuCI form of the
 * UCI config u60wifi, saved with Save & Apply (the service reloads on the change).
 *
 * ubus u60pro.wifi: status -> {enabled, up, mode, modes[], untested[], ssid, key, encryption, country, radios[{name, disabled, up,
 * ifname, band, width, channel, ssid, encryption, stations}]}; set {mode | enabled | ...}; radio {name, disabled}. */
var callStatus = rpc.declare({ object: 'u60pro.wifi', method: 'status' });
var callMode = rpc.declare({ object: 'u60pro.wifi', method: 'set', params: [ 'mode' ] });
var callEnable = rpc.declare({ object: 'u60pro.wifi', method: 'set', params: [ 'enabled' ] });
var callRadio = rpc.declare({ object: 'u60pro.wifi', method: 'radio', params: [ 'name', 'disabled' ] });

/* the combinations by the names the service uses; one it reports and this page does not know is shown by its name */
var MODES = {
	'2g+5g': { title: _('2.4 GHz + 5 GHz'), bands: [ '2g', '5g' ], text: _('2.4 GHz reaches further and suits older devices, 5 GHz is faster.') },
	'5g': { title: _('5 GHz'), bands: [ '5g' ], text: _('One network on 5 GHz, up to 160 MHz wide.') },
	'5g+6g': { title: _('5 GHz + 6 GHz'), bands: [ '5g', '6g' ], text: _('160 MHz on each band. 6 GHz is for devices with Wi-Fi 6E or Wi-Fi 7.') },
	'6g': { title: _('6 GHz, 320 MHz'), bands: [ '6g' ], text: _('Both radios joined into one 320 MHz channel: the fastest link, for Wi-Fi 7 devices only.') },
	'5g+5g': { title: _('5 GHz + 5 GHz'), bands: [ '5gl', '5gh' ], text: _('Two networks on 5 GHz: the lower channels (36–64) and the upper ones (149–165).') },
	'2g': { title: _('2.4 GHz'), bands: [ '2g' ], text: _('2.4 GHz only: the longest range, the lowest speed.') }
};
var BAND = { '2g': '2.4 GHz', '5g': '5 GHz', '5gl': _('5 GHz low'), '5gh': _('5 GHz high'), '6g': '6 GHz' };
var ENC = [ [ 'sae', _('WPA3') ], [ 'sae-mixed', _('WPA2 / WPA3') ], [ 'psk2', _('WPA2') ] ];

function bandPill(b) {
	return E('span', { 'class': 'k-band b' + String(b).charAt(0) }, BAND[b] || b);
}

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
		var picked = null, opts = E('div', { 'class': 'k-opts', 'role': 'radiogroup' }), pending = E('span', { 'class': 'k-pending' });
		var apply = E('button', { 'class': 'cbi-button cbi-button-action', 'disabled': '' }, _('Switch'));
		var main = hw.action(function(on) { return callEnable(on); }, notice, refresh);
		var radioSw = {};

		function radioSwitch(name) {
			if (!radioSw[name])
				radioSw[name] = hw.action(function(on) { return callRadio(name, !on); }, notice, refresh);
			return radioSw[name];
		}

		function drawModes() {
			var names = (st.modes || []).slice(), cur = picked || st.mode;
			if (st.mode && st.mode !== 'custom' && names.indexOf(st.mode) < 0) names.unshift(st.mode);
			opts.replaceChildren.apply(opts, names.map(function(name) {
				var m = MODES[name] || { title: name, bands: [], text: '' };
				var o = E('div', { 'class': 'k-opt' + (name === cur ? ' on' : ''), 'role': 'radio', 'tabindex': '0', 'aria-checked': name === cur ? 'true' : 'false' }, [
					E('div', { 'class': 'k-opt-h' }, [ E('span', {}, m.title), name === st.mode ? kit.chip(_('In use'), 'ok') : '',
						(st.untested || []).indexOf(name) >= 0 ? kit.chip(_('Not tested'), 'warn') : '' ]),
					E('div', { 'class': 'k-bands' }, m.bands.map(bandPill)),
					E('div', { 'class': 'k-opt-t' }, m.text)
				]);
				var pick = function() {
					picked = name === st.mode ? null : name;
					drawModes();
				};
				o.addEventListener('click', pick);
				o.addEventListener('keydown', function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
				return o;
			}));
			apply.disabled = !picked;
			pending.textContent = picked ? _('Not applied yet') : '';
		}

		apply.addEventListener('click', function() {
			if (!picked) return;
			var want = picked;
			apply.disabled = true;
			hw.note(notice, null);
			callMode(want).then(function(r) {
				var bad = hw.failure(r);
				if (bad) hw.note(notice, bad, true);
				else {
					picked = null;
					hw.note(notice, _('Switching to %s. Devices connect again in a few seconds.').format((MODES[want] || {}).title || want));
				}
			}).catch(function(e) { hw.note(notice, (e && e.message) || String(e), true); }).then(refresh);
		});

		function draw() {
			var radios = st.radios || [], total = 0, single = MODES[st.mode] && MODES[st.mode].bands.length === 1;
			radios.forEach(function(r) { if (r.up && r.stations) total += r.stations; });
			main.set(st.up != null ? st.up : st.enabled, !have);
			var list = [ { icon: 'wifi', label: 'Wi-Fi', value: !have ? null : st.up ? _('On') : (st.enabled ? _('Starting') : _('Off')), chip: main.el,
				meta: have ? ((MODES[st.mode] || {}).title || (st.mode === 'custom' ? _('Own combination') : st.mode)) : null } ];
			radios.forEach(function(r, i) {
				var s = radioSwitch(r.name), unused = r.disabled && single;
				s.set(!r.disabled, !st.enabled || unused);
				list.push({ icon: 'radio-tower', label: _('Radio %d').format(i + 1), chip: s.el,
					value: r.disabled ? _('Off') : (BAND[r.band] || r.band), tone: r.disabled ? 'dim' : '',
					unit: !r.disabled && r.width ? r.width + ' MHz' : null,
					meta: unused ? _('Not used in this combination')
						: r.disabled ? null
						: !r.up ? _('Not running')
						: [ r.channel ? _('Channel %d').format(r.channel) : null, r.ssid, _('%d clients').format(r.stations || 0) ].filter(Boolean).join(' · ') });
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
		var s = m.section(form.NamedSection, 'main', 'wifi', _('Network name and password'),
			_('Both radios use this name and password unless a radio has its own name below.'));
		var o = s.option(form.Value, 'ssid', _('Name (SSID)'));
		o.datatype = 'and(minlength(1),maxlength(32))';
		o.rmempty = false;
		o = s.option(form.Value, 'key', _('Password'));
		o.password = true;
		o.datatype = 'wpakey';
		o.rmempty = false;
		o = s.option(form.ListValue, 'encryption', _('Security'), _('6 GHz always uses WPA3, whatever is chosen here.'));
		ENC.forEach(function(c) { o.value(c[0], c[1]); });
		o.default = 'sae-mixed';
		o = s.option(form.Value, 'country', _('Country code'), _('Two letters. It decides which channels and how much power the radios may use.'));
		o.datatype = 'and(minlength(2),maxlength(2))';
		o.rmempty = false;

		[ 'radio0', 'radio1' ].forEach(function(name, i) {
			if (!uci.get('u60wifi', name)) return;
			s = m.section(form.NamedSection, name, 'radio', _('Radio %d').format(i + 1),
				_('The band and the channel width follow the radio combination above.'));
			o = s.option(form.Value, 'channel', _('Channel'), _('Empty: the service picks one for the band.'));
			o.datatype = 'range(1,233)';
			o.placeholder = _('automatic');
			o.rmempty = true;
			o = s.option(form.Value, 'ssid', _('Own name (SSID)'), _('Empty: the name above.'));
			o.datatype = 'maxlength(32)';
			o.rmempty = true;
		});

		draw();
		poll.add(refresh, 3);
		return kit.formPage(m, [ notice, tiles,
			kit.card({ title: _('Radio combination'), icon: 'radio-tower', body: [ opts, kit.actions([ pending, apply ]) ],
				help: _('Switching restarts Wi-Fi: every device connects again, and one that cannot use the new band stays offline. If you are on Wi-Fi yourself, make sure your device supports the combination before switching.') })
		], [ 'lock', 'radio-tower', 'radio-tower' ]);
	}
});
