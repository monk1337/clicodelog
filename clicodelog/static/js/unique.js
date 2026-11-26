// "Unique only": collapse messages that repeat verbatim.
//
// Long agent sessions are full of the same prompt pasted again and again. With
// this on, each distinct message is shown once, with a "×N" badge saying how
// many times it was sent; the repeats are hidden.
//
// It works on the rendered DOM rather than the message array on purpose. The
// lazy loader, the two-way paging and the role filter all index into
// getActiveMessages(); removing entries from it would shift every index they
// depend on. Each message element instead carries a fingerprint
// (data-dupkey, set in buildMessageEl), and this pass hides later copies with a
// CSS class. It therefore composes with the User / AI / Tools filters and keeps
// working as pages arrive at either end.

var uniqueOnly = false;
var UNIQUE_PREF_KEY = 'clicodelog-unique-only';

try { uniqueOnly = localStorage.getItem(UNIQUE_PREF_KEY) === '1'; } catch (e) { /* private mode */ }

// FNV-1a, 32-bit. Messages can be 200k characters; a fingerprint keeps the
// attribute small. The role and length are folded in, so a collision would
// also need an identical role and length.
function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}

function normaliseForDedup(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Same role and same words means the same message. Tool-only turns are
// fingerprinted by tool name and input, so a repeated identical command
// collapses too, while two different commands never do.
function messageDupKey(msg) {
    if (!msg) return '';
    var text = normaliseForDedup(msg.content);
    if (!text && msg.tool_uses && msg.tool_uses.length) {
        text = 'tools:' + normaliseForDedup(msg.tool_uses.map(function(t) {
            var inp = t.input;
            try { inp = typeof inp === 'object' ? JSON.stringify(inp) : String(inp); }
            catch (e) { inp = ''; }
            return (t.name || '') + ' ' + inp;
        }).join(' | '));
    }
    if (!text && msg.thinking) text = 'thinking:' + normaliseForDedup(msg.thinking);
    if (!text) return '';            // nothing to compare — never collapse
    return (msg.role || '') + ':' + text.length + ':' + fnv1a(text);
}

function toggleUniqueOnly(on) {
    uniqueOnly = !!on;
    try { localStorage.setItem(UNIQUE_PREF_KEY, uniqueOnly ? '1' : '0'); } catch (e) { /* ignore */ }
    syncUniqueToggles();
    applyUniqueFilter();
}

function syncUniqueToggles() {
    document.querySelectorAll('.unique-toggle input').forEach(function(cb) {
        cb.checked = uniqueOnly;
    });
}

function formatShortTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function applyUniqueFilter() {
    var mc = document.getElementById('messages-container');
    var status = document.getElementById('unique-status');
    if (!mc) { if (status) status.textContent = ''; return; }

    mc.classList.toggle('unique-only', uniqueOnly);
    mc.querySelectorAll('.dup-badge').forEach(function(b) { b.remove(); });
    var nodes = mc.querySelectorAll('.message');

    if (!uniqueOnly) {
        nodes.forEach(function(el) { el.classList.remove('dup-repeat', 'dup-revealed'); });
        if (status) status.textContent = '';
        return;
    }

    // The first copy in display order is the one kept: with newest-first that
    // is the most recent time the message was sent.
    var groups = {};
    var hidden = 0;
    nodes.forEach(function(el) {
        var k = el.dataset.dupkey;
        el.classList.remove('dup-repeat');
        if (!k) return;
        var g = groups[k];
        if (!g) { groups[k] = { el: el, count: 1, times: [] }; return; }
        g.count++;
        if (g.times.length < 12) g.times.push(el.dataset.ts);
        el.classList.add('dup-repeat');
        hidden++;
    });

    Object.keys(groups).forEach(function(k) {
        var g = groups[k];
        if (g.count < 2) return;
        var header = g.el.querySelector('.message-header') || g.el;
        var badge = document.createElement('span');
        badge.className = 'dup-badge';
        badge.textContent = '×' + g.count;
        var when = g.times.map(formatShortTime).filter(Boolean);
        // ' · ' between entries: the times themselves contain a comma.
        badge.title = 'Sent ' + g.count + ' times' +
            (when.length ? '. Other copies: ' + when.join('  ·  ') +
                (g.count - 1 > when.length ? '  ·  …' : '') : '');
        header.appendChild(badge);
    });

    if (status) {
        var partial = typeof hasMoreOnServer === 'function' && hasMoreOnServer();
        status.textContent = hidden
            ? 'Hiding ' + hidden.toLocaleString() + ' repeat' + (hidden === 1 ? '' : 's') +
              (partial ? ' (loaded messages — Load All to cover the whole session)' : '')
            : 'No repeats' + (partial ? ' in loaded messages' : '');
    }
}

document.addEventListener('DOMContentLoaded', syncUniqueToggles);
syncUniqueToggles();
