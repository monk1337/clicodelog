// Conversation data: paging from the server and the display model.
//
// Every message gets a stable id on arrival — its raw index in the session
// (msg._i) — so the list can key DOM nodes, measured heights and search hits
// by message rather than by position, and positions can change freely as
// pages arrive at either end or filters change.
//
// Filters (date, role, tool visibility, "Unique only") are applied here, in
// buildView(), instead of hiding rendered nodes with CSS. A message a filter
// excludes is never rendered at all, so it costs no DOM and no memory.

function stripProtocolMessages(msgs) {
    // Empty user turns that only carry a tool result are noise in a transcript.
    return msgs.filter(function(m) {
        return !(m.role === 'user' && !m.content && !(m.tool_uses && m.tool_uses.length > 0));
    });
}

// Stamp stable ids (raw server index), then drop protocol noise.
function ingestMessages(rawMsgs, offset) {
    for (var j = 0; j < rawMsgs.length; j++) rawMsgs[j]._i = offset + j;
    return stripProtocolMessages(rawMsgs);
}

// Prepare a conversation payload from the API (once per object).
function ingestConversation(conv) {
    if (conv._ingested) return conv;
    var offset = conv.offset || 0;
    var raw = conv.messages || [];
    conv._ws = offset;
    conv._we = offset + raw.length;
    conv.messages = ingestMessages(raw, offset);
    conv._ingested = true;
    return conv;
}

function syncWindowGlobals() {
    if (!currentConversation) { convWindowStart = convWindowEnd = 0; return; }
    convWindowStart = currentConversation._ws || 0;
    convWindowEnd = currentConversation._we || 0;
}

function hasOlderOnServer() {
    return !!(currentConversation && currentConversation.total_messages != null &&
              convWindowStart > 0);
}

function hasNewerOnServer() {
    return !!(currentConversation && currentConversation.total_messages != null &&
              convWindowEnd < currentConversation.total_messages);
}

function hasMoreOnServer() {
    return hasOlderOnServer() || hasNewerOnServer();
}

function conversationUrl(params) {
    return '/api/projects/' + encodeURIComponent(currentProjectId) +
        '/sessions/' + encodeURIComponent(currentSessionId) +
        '?source=' + encodeURIComponent(currentSource) + (params ? '&' + params : '');
}

async function fetchConvPage(offset, limit) {
    var r = await fetch(conversationUrl('limit=' + limit + '&offset=' + offset));
    if (!r.ok) return null;
    var page = await r.json();
    return (page && Array.isArray(page.messages)) ? page : null;
}

// Fetch one page further in a direction and merge it. Returns true if the
// loaded window grew. Callers rebuild the view afterwards.
async function _extend(older, limit) {
    var conv = currentConversation;
    var total = conv.total_messages;
    var offset, want;
    if (older) {
        if (convWindowStart <= 0) return false;
        offset = Math.max(0, convWindowStart - limit);
        want = convWindowStart - offset;
    } else {
        if (convWindowEnd >= total) return false;
        offset = convWindowEnd;
        want = Math.min(limit, total - convWindowEnd);
    }
    if (want <= 0) return false;

    var seq = sessionRequestSeq;
    var page = await fetchConvPage(offset, want);
    if (seq !== sessionRequestSeq || conv !== currentConversation || !page) return false;
    if (!page.messages.length) {
        // The server has nothing where it said it would; stop asking.
        if (older) conv._ws = convWindowStart = 0;
        else conv._we = convWindowEnd = conv.total_messages;
        return false;
    }
    var clean = ingestMessages(page.messages, page.offset);
    if (older) {
        conv.messages = clean.concat(conv.messages);
        conv._ws = page.offset;
    } else {
        conv.messages = conv.messages.concat(clean);
        conv._we = page.offset + page.messages.length;
    }
    conv.total_messages = page.total_messages;
    syncWindowGlobals();
    return true;
}

// The busy flag lives on the conversation, not in a global: a page still in
// flight for the previous session must not block (or, on finishing, unblock)
// fetches for the one now on screen.
async function extendConversation(older, limit) {
    var conv = currentConversation;
    if (!conv || conv._busy || conv.total_messages == null) return false;
    conv._busy = true;
    try { return await _extend(older, limit || CONV_PAGE); }
    catch (e) { return false; }
    finally { conv._busy = false; }
}

// Pull every page the server still holds. The flag is held for the whole loop
// so the list's own edge-fetching cannot interleave with it.
async function fetchWholeSession(onProgress) {
    var conv = currentConversation;
    if (!conv || conv.total_messages == null) return;
    // An edge fetch may be running; wait for it rather than giving up.
    for (var w = 0; conv._busy && w < 200; w++) {
        await new Promise(function(res) { setTimeout(res, 50); });
    }
    if (conv._busy || conv !== currentConversation) return;
    conv._busy = true;
    try {
        var guard = 0;
        while (conv === currentConversation && hasMoreOnServer() && guard++ < 5000) {
            var grew = await _extend(hasOlderOnServer(), LOAD_ALL_PAGE);
            if (!grew) break;
            if (onProgress) onProgress(convWindowEnd - convWindowStart, conv.total_messages);
        }
    } finally {
        conv._busy = false;
    }
}

function messageTime(m) {
    if (m._t === undefined) {
        var t = m.timestamp ? Date.parse(m.timestamp) : NaN;
        m._t = isNaN(t) ? null : t;
    }
    return m._t;
}

function inDateRange(m) {
    if (dateFromFilter == null && dateToFilter == null) return true;
    var t = messageTime(m);
    if (t == null) return false;
    if (dateFromFilter != null && t < dateFromFilter) return false;
    if (dateToFilter != null && t > dateToFilter) return false;
    return true;
}

// Chronological, date-filtered. Exports use this so they stay in natural order.
function getChronologicalMessages() {
    if (!currentConversation) return [];
    return currentConversation.messages.filter(inDateRange);
}

function hasTools(m) { return !!(m.tool_uses && m.tool_uses.length); }
function hasText(m) { return !!(m.content && m.content.trim()); }

function messageText(msg) {
    var parts = [];
    if (msg.content) parts.push(msg.content);
    if (msg.thinking) parts.push(msg.thinking);
    (msg.tool_uses || []).forEach(function(t) {
        if (t.name) parts.push(t.name);
        if (t.input) parts.push(typeof t.input === 'object' ? JSON.stringify(t.input) : String(t.input));
    });
    return parts.join('\n').toLowerCase();
}

// The display model. Applies every filter, then the display order.
function buildView() {
    var conv = currentConversation;
    convDup = {};
    if (!conv) { convView = []; return convView; }

    var src = conv.messages;
    var n = src.length;
    var newest = msgOrder === 'newest';
    var roles = activeFilters;
    // The Tools chip means "show me tool calls", whatever the global setting.
    var hideToolOnly = document.body.classList.contains('hide-tool-boxes') && !roles.has('tools');
    var unique = typeof uniqueOnly !== 'undefined' && uniqueOnly;
    var firstByKey = unique ? Object.create(null) : null;
    var out = [];

    for (var k = 0; k < n; k++) {
        var m = src[newest ? n - 1 - k : k];
        var forced = revealedIds.size && revealedIds.has(m._i);
        if (!inDateRange(m) && !forced) continue;
        if (hideToolOnly && hasTools(m) && !hasText(m) && !forced) continue;
        if (roles.size && !forced) {
            var ok = (roles.has('user') && m.role === 'user') ||
                     (roles.has('assistant') && m.role === 'assistant') ||
                     (roles.has('tools') && hasTools(m));
            if (!ok) continue;
        }
        if (unique) {
            var key = m._dk !== undefined ? m._dk : (m._dk = messageDupKey(m));
            if (key) {
                var first = firstByKey[key];
                if (first) {
                    var d = convDup[first._i] || (convDup[first._i] = { count: 1, times: [] });
                    d.count++;
                    if (d.times.length < 12) d.times.push(m.timestamp);
                    if (!forced) continue;
                } else {
                    firstByKey[key] = m;
                }
            }
        }
        out.push(m);
    }
    convView = out;
    return out;
}

// Kept for older callers.
function getActiveMessages() { return convView; }

// Whole-session token usage from the metadata index (the loaded window would
// under-report it). The listing stores it with short keys.
function indexedSessionUsage() {
    var info = currentConversation && currentConversation.info;
    var u = info && info.usage;
    if (!u) {
        var s = (currentSessions || []).find(function(x) { return x.id === currentSessionId; });
        u = s && s.usage;
    }
    if (!u || u.input === undefined) return null;
    return {
        input_tokens: u.input || 0,
        output_tokens: u.output || 0,
        cache_read_input_tokens: u.cache_read || 0,
        cache_creation_input_tokens: u.cache_creation || 0,
    };
}
