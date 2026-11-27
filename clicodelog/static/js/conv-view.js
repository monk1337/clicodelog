// Showing a conversation: header, the virtual list, status, and jumping to a
// message. Toolbar handlers and in-conversation find live in conversation.js.

var convSearchSet = new Set();      // ids of messages matching the find query
var convSearchCurrentId = null;     // id of the focused match

function mkEl(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function setConvChrome(visible) {
    var head = document.getElementById('conv-head');
    if (head && !visible) head.textContent = '';
    var bar = document.getElementById('conv-filter-bar');
    if (bar) bar.hidden = !visible;
    var fabs = document.getElementById('jump-fabs');
    if (fabs) fabs.hidden = !visible;
}

// Loading / error / empty states blank the header too, so the header of the
// previous session never sits above a spinner for a different one.
function showConvLoading(text) {
    vlDestroy();
    setConvChrome(false);
    setPanel('conversation-content', loadingSpinner(text || 'Loading conversation…'));
}

function showConvError(message, retry) {
    vlDestroy();
    setConvChrome(false);
    setPanel('conversation-content', errorState(message, retry));
}

function resetConversationPane() {
    vlDestroy();
    currentConversation = null;
    convView = [];
    setConvChrome(false);
    setPanel('conversation-content', emptyState('chat',
        'Pick a session to read it here. Press ⌘K to search every conversation.',
        'Your agent history'));
}

// opts.keepFilters: keep role/date/find state (order switch, tab restore).
// opts.anchorUuid:  centre this message and flash it (bookmarks, search hits).
// opts.restore:     {id, delta} put this message back exactly where it was.
function renderConversation(conv, opts) {
    opts = opts || {};
    ingestConversation(conv);
    if (currentConversation && currentConversation !== conv) cacheEnforce();
    currentConversation = conv;
    syncWindowGlobals();
    revealedIds.clear();
    if (typeof refreshBookmarkSet === 'function') refreshBookmarkSet();

    if (!opts.keepFilters) {
        activeFilters.clear();
        dateFromFilter = dateToFilter = null;
        resetConvSearchState();
    }
    syncToolbarState();

    renderConvHead(conv);
    setConvChrome(true);

    var body = document.getElementById('conversation-content');
    body.textContent = '';
    if (conv.summaries && conv.summaries.length) body.appendChild(buildSummaries(conv.summaries));
    var host = mkEl('div', 'messages conv-list');
    host.id = 'messages-container';
    body.appendChild(host);

    vlCreate(host);
    buildView();
    if (opts.restore) vlRebuild({ anchor: opts.restore });
    else vlRebuild({ scrollTo: 'top', anchor: null });
    updateConvStatus();
    if (opts.keepFilters && convSearchQuery) recomputeFind(false);
    if (opts.anchorUuid && !scrollToAnchor(opts.anchorUuid) && conv.anchor_index >= 0) {
        // The hit was in something the transcript doesn't show (a tool
        // result); land on the nearest message that is shown.
        scrollNearIndex(conv.anchor_index);
    }
}

function flashNode(node) {
    if (!node) return;
    node.classList.add('bookmark-flash');
    setTimeout(function() { node.classList.remove('bookmark-flash'); }, 1800);
}

function scrollNearIndex(index) {
    if (!VL || !convView.length) return;
    vlEnsureOffsets();
    var m = convView[Math.min(vlNearestPos(index), convView.length - 1)];
    if (m) vlScrollToId(m._i, 'center', flashNode);
}

function hiddenRepeatCount() {
    var n = 0;
    for (var k in convDup) n += convDup[k].count - 1;
    return n;
}

function updateConvStatus() {
    var st = document.getElementById('conv-filter-status');
    var conv = currentConversation;
    if (!st) return;
    if (!conv) { st.textContent = ''; return; }
    var filtered = activeFilters.size || dateFromFilter != null || dateToFilter != null ||
        (typeof uniqueOnly !== 'undefined' && uniqueOnly);
    var parts = [];
    if (filtered) parts.push(convView.length.toLocaleString() + ' shown');
    var hidden = hiddenRepeatCount();
    if (hidden) parts.push(hidden.toLocaleString() + ' repeat' + (hidden === 1 ? '' : 's') + ' collapsed');
    if (dateFromFilter != null || dateToFilter != null) parts.push('date range on');
    if (filtered && hasMoreOnServer()) {
        parts.push('of ' + (convWindowEnd - convWindowStart).toLocaleString() + ' loaded (' +
            conv.total_messages.toLocaleString() + ' in session)');
    }
    st.textContent = parts.join(' · ');
}

function setConvBusy(text) {
    var b = document.getElementById('conv-filter-loading');
    if (!b) return;
    b.hidden = !text;
    var label = b.querySelector('.busy-text');
    if (label) label.textContent = text || '';
}

// "Load all" fetches the whole session so find, filters and Unique cover all
// of it. Rendering stays virtual, so the DOM no longer grows with the session.
async function loadAllMessages(onComplete) {
    closeMenus();
    var conv = currentConversation;
    if (!conv) { if (onComplete) onComplete(); return; }
    if (hasMoreOnServer()) {
        setConvBusy('Loading all ' + conv.total_messages.toLocaleString() + ' messages…');
        try {
            await fetchWholeSession(function(have, t) {
                setConvBusy('Loading ' + have.toLocaleString() + ' of ' + t.toLocaleString() + '…');
            });
        } finally { setConvBusy(''); }
        if (conv !== currentConversation) return;
        buildView();
        vlRebuild();
        toast(hasMoreOnServer() ? 'Could not load every message'
            : 'All ' + conv.total_messages.toLocaleString() + ' messages loaded');
    } else {
        toast('The whole conversation is already loaded');
    }
    updateConvStatus();
    if (onComplete) onComplete();
}

function findLoadedMessage(anchor) {
    var msgs = currentConversation ? currentConversation.messages : [];
    for (var k = 0; k < msgs.length; k++) {
        if (msgs[k].uuid === anchor || bookmarkAnchor(msgs[k], msgs[k]._i) === anchor) return msgs[k];
    }
    return null;
}

// Scroll to a message that is already loaded. Returns false if it isn't, so
// callers can fetch a window around it instead.
function scrollToAnchor(anchor) {
    if (!currentConversation || !VL || !anchor) return false;
    var m = findLoadedMessage(anchor);
    if (!m) return false;
    if (vlPosById(m._i) < 0) {
        // Hidden by a filter or by "Unique only": show this one anyway.
        revealedIds.add(m._i);
        buildView();
        vlRebuild();
        updateConvStatus();
    }
    vlScrollToId(m._i, 'center', flashNode);
    return true;
}

// Open the session centred on one message: a bookmark or a search hit lands
// instantly instead of loading everything before it first.
async function openAtAnchor(uuid) {
    if (!uuid || !currentProjectId || !currentSessionId) return false;
    if (scrollToAnchor(uuid)) return true;
    var seq = ++sessionRequestSeq;
    showConvLoading('Opening message…');
    try {
        var r = await fetch(conversationUrl('limit=' + ANCHOR_WINDOW + '&around_uuid=' + encodeURIComponent(uuid)));
        if (seq !== sessionRequestSeq) return false;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var conv = await r.json();
        if (seq !== sessionRequestSeq) return false;
        if (!conv || conv.error || !Array.isArray(conv.messages)) throw new Error('bad payload');
        renderConversation(conv, { anchorUuid: uuid });
        return true;
    } catch (e) {
        if (seq !== sessionRequestSeq) return false;
        showConvError('Could not open that message.', function() { openAtAnchor(uuid); });
        return false;
    }
}

// Re-open the current session on a window around one message and put that
// message back where it was on screen (used after the tab was discarded).
async function reopenAround(anchor, opts) {
    if (!currentProjectId || !currentSessionId) return;
    var seq = ++sessionRequestSeq;
    var params = anchor
        ? 'limit=' + CONV_PAGE + '&offset=' + Math.max(0, anchor.id - (CONV_PAGE >> 1))
        : 'limit=' + CONV_PAGE + (msgOrder === 'newest' ? '&tail=true' : '&offset=0');
    try {
        var r = await fetch(conversationUrl(params));
        if (seq !== sessionRequestSeq) return;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var conv = await r.json();
        if (seq !== sessionRequestSeq) return;
        if (!conv || conv.error || !Array.isArray(conv.messages)) throw new Error('bad payload');
        renderConversation(conv, Object.assign({ keepFilters: true, restore: anchor }, opts || {}));
    } catch (e) {
        if (seq !== sessionRequestSeq) return;
        showConvError('Could not reload this conversation.', function() { reopenAround(anchor, opts); });
    }
}

function openFocusView() {
    if (!currentProjectId || !currentSessionId) return;
    window.open('/view?source=' + encodeURIComponent(currentSource) +
        '&project=' + encodeURIComponent(currentProjectId) +
        '&session=' + encodeURIComponent(currentSessionId), '_blank', 'noopener');
}
