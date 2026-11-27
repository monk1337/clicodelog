// "Unique only": collapse messages that repeat verbatim.
//
// Long agent sessions are full of the same prompt pasted again and again. With
// this on, each distinct message is shown once, with a "×N" badge saying how
// many times it was sent.
//
// The collapsing happens in the display model (buildView in conv-data.js), so
// hidden repeats are never rendered at all and it composes with the role,
// tool and date filters. The copy kept is the first in display order: with
// newest-first, the most recent time the message was sent.

var uniqueOnly = false;
var UNIQUE_PREF_KEY = 'clicodelog-unique-only';

try { uniqueOnly = localStorage.getItem(UNIQUE_PREF_KEY) === '1'; } catch (e) { /* private mode */ }

// FNV-1a, 32-bit. Messages can be 200k characters; a fingerprint keeps the
// key small. The role and length are folded in, so a collision would also
// need an identical role and length.
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
    if (typeof refreshView === 'function') refreshView();
}

function syncUniqueToggles() {
    document.querySelectorAll('.unique-toggle input').forEach(function(cb) {
        cb.checked = uniqueOnly;
        var chip = cb.closest('.chip');
        if (chip) chip.classList.toggle('active', uniqueOnly);
    });
}

document.addEventListener('DOMContentLoaded', syncUniqueToggles);
syncUniqueToggles();
