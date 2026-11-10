'use strict';
'require baseclass';
'require rpc';
'require u60pro.kit as kit';

/* Shared helpers of the U60 Pro device pages (Status > Battery, System > Power, Screen, Buttons): the calls to the hardware service
 * (ubus u60pro.hw, package u60pro-hw) and small value helpers. */
var HW = 'u60pro.hw';

return baseclass.extend({
	kit: kit,

	call: {
		status: rpc.declare({ object: HW, method: 'status' }),
		history: rpc.declare({ object: HW, method: 'history', params: [ 'minutes' ] }),
		screenPower: rpc.declare({ object: HW, method: 'screen', params: [ 'power' ] }),
		brightness: rpc.declare({ object: HW, method: 'screen', params: [ 'brightness' ] }),
		charging: rpc.declare({ object: HW, method: 'charging', params: [ 'paused' ] }),
		powerbank: rpc.declare({ object: HW, method: 'powerbank', params: [ 'enabled' ] })
	},

	/* the state of the hardware service; a failed call gives an object with an error instead of rejecting */
	status: function() {
		return this.call.status().then(function(r) {
			return r && r.battery ? r : { error: _('The hardware service (u60pro-hw) is not running.') };
		}).catch(function(e) { return { error: _('The hardware service (u60pro-hw) is not running.') }; });
	},

	/* a missing value is shown as an em dash; numbers are fixed to `digits` decimals before the unit */
	text: function(v, unit, digits) {
		if (v === null || v === undefined || v === '')
			return '—';
		if (typeof v === 'number' && digits !== undefined)
			v = v.toFixed(digits);
		return String(v) + (unit || '');
	},

	watts: function(mw, signed) {
		if (mw === null || mw === undefined) return '—';
		return (signed && mw > 0 ? '+' : '') + (mw / 1000).toFixed(2) + ' W';
	},

	span: function(s) {
		if (s === null || s === undefined) return null;
		var m = Math.max(0, Math.round(s / 60));
		if (m < 60) return _('%d min').format(m);
		if (m >= 1440) return _('%d d %d h').format(Math.floor(m / 1440), Math.floor(m % 1440 / 60));
		return _('%d h %d min').format(Math.floor(m / 60), m % 60);
	},

	note: function(box, msg, bad) {
		box.replaceChildren(msg ? E('div', { 'class': bad ? 'alert-message warning' : 'alert-message success' }, msg) : '');
	},

	/* the text of a failed command, or null */
	failure: function(r) {
		if (!r) return _('No reply from the device');
		if (r.error) return String(r.error);
		if (r.ok === false) return _('The command failed');
		return null;
	},

	/* a switch that runs `fn(on)` (a promise of a reply), puts itself back when that fails and then calls `after` */
	action: function(fn, notice, after) {
		var self = this, s = kit.sw(false);
		s.input.addEventListener('change', function() {
			var want = s.input.checked;
			s.input.disabled = true;
			Promise.resolve(fn(want)).then(function(r) {
				var bad = self.failure(r);
				if (bad) { s.input.checked = !want; self.note(notice, bad, true); }
			}).catch(function(e) {
				s.input.checked = !want;
				self.note(notice, (e && e.message) || String(e), true);
			}).then(function() { s.input.disabled = false; if (after) after(); });
		});
		s.set = function(v, dis) { if (!s.input.disabled || dis) s.input.checked = !!v; s.input.disabled = !!dis; };
		return s;
	},

	/* a labelled row in a card, like a LuCI form row */
	row: function(label, field, descr) {
		return E('div', { 'class': 'cbi-value' }, [ E('label', { 'class': 'cbi-value-title' }, label),
			E('div', { 'class': 'cbi-value-field' }, [ field, descr || '' ]) ]);
	},

	batteryState: function(st) {
		var b = st.battery || {}, c = st.charger || {}, g = st.charge || {};
		if (!b.available) return _('No battery reported');
		if (b.status === 'Charging') return _('Charging');
		if (b.status === 'Full') return _('Full, on the charger');
		if (c.online && g.holding) return _('On the charger, not charging');
		if (c.online) return _('On the charger');
		return _('On battery');
	}
});
