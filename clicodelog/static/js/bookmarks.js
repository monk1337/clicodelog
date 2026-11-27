// Pin / bookmark messages. Persisted server-side in ~/.clicodelog/bookmarks.json
// so they survive every sync. Anchored by message uuid (or a stable synthetic
// key) so clicking a bookmark jumps to the exact message in its conversation.

var bookmarkSet = {};   // anchor -> bookmark obj (for current quick lookup)
var allBookmarks = [];  // full list from server

function bookmarkAnchor(msg, idx) {
    if (msg.uuid) return msg.uuid;
    var t = msg.timestamp || '';
    var head = (msg.content || '').slice(0, 24).replace(/\s+/g, '_');
    return 'm' + idx + '_' + t + '_' + head;
}

function isBookmarked(anchor) {
    return !!bookmarkSet[anchor];
}

function refreshBookmarkSet() {
    bookmarkSet = {};
    allBookmarks.forEach(function(b) {
        if (b.session_id === currentSessionId && b.source === currentSource) {
            bookmarkSet[b.uuid || b.anchor] = b;
        }
    });
}

function loadBookmarks(cb) {
    fetch('/api/bookmarks')
        .then(function(r) { return r.json(); })
        .then(function(list) {
            allBookmarks = list || [];
            refreshBookmarkSet();
            refreshPins();
            if (cb) cb();
        })
        .catch(function() { if (cb) cb(); });
}

function bookmarkPreview(msg) {
    return (msg.content || '').trim().slice(0, 160) ||
        (msg.thinking ? '[thinking] ' + msg.thinking.slice(0, 140) : '') ||
        (msg.tool_uses && msg.tool_uses.length ? '[tool: ' + msg.tool_uses[0].name + ']' : '[no text]');
}

function toggleBookmark(msg, idx, anchor, btn) {
    if (isBookmarked(anchor)) {
        var b = bookmarkSet[anchor];
        fetch('/api/bookmarks/' + encodeURIComponent(b.id), { method: 'DELETE' })
            .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
            .then(function(list) {
                allBookmarks = list || [];
                refreshBookmarkSet();
                if (btn) setPinState(btn, false);
                toast('Bookmark removed');
            })
            .catch(function() { toast('Could not remove the bookmark'); });
        return;
    }
    var body = {
        source: currentSource,
        project_id: currentProjectId,
        session_id: currentSessionId,
        uuid: msg.uuid || null,
        anchor: anchor,
        msg_index: idx,
        role: msg.role,
        timestamp: msg.timestamp || null,
        preview: bookmarkPreview(msg),
    };
    fetch('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(list) {
            allBookmarks = list || [];
            refreshBookmarkSet();
            if (btn) setPinState(btn, true);
            toast('Bookmarked');
        })
        .catch(function() { toast('Could not save the bookmark'); });
}

function openBookmarksPanel() {
    var panel = document.getElementById('bookmarks-panel');
    if (!panel) return;
    if (panel.classList.contains('open')) { closeBookmarksPanel(); return; }
    loadBookmarks(function() { renderBookmarksPanel(); });
    panel.classList.add('open');
    var btn = document.getElementById('bookmarks-btn');
    if (btn) btn.classList.add('active');
}

function closeBookmarksPanel() {
    var panel = document.getElementById('bookmarks-panel');
    if (panel) panel.classList.remove('open');
    var btn = document.getElementById('bookmarks-btn');
    if (btn) btn.classList.remove('active');
}

// renderBookmarksPanel lives in bookmarks-panel.js; scrollToAnchor and
// openAtAnchor in conv-view.js.

function gotoBookmark(b) {
    closeBookmarksPanel();
    var anchor = b.uuid || b.anchor;
    var sameConv = b.session_id === currentSessionId && b.source === currentSource &&
        b.project_id === currentProjectId;
    if (sameConv) {
        // Loaded: scroll to it. Otherwise open a window centred on it, rather
        // than loading the entire session to reach one message.
        if (!scrollToAnchor(anchor)) openAtAnchor(anchor);
        return;
    }
    // Another conversation opens in the focus view, anchored.
    window.open('/view?source=' + encodeURIComponent(b.source) +
        '&project=' + encodeURIComponent(b.project_id) +
        '&session=' + encodeURIComponent(b.session_id) +
        '&anchor=' + encodeURIComponent(anchor), '_blank', 'noopener');
}

// Bookmarks can arrive after a conversation rendered; fix up its stars.
function refreshPins() {
    if (typeof VL === 'undefined' || !VL) return;
    VL.nodes.forEach(function(wrap) {
        var btn = wrap.querySelector('.pin-btn');
        var msgEl = wrap.firstChild;
        if (btn && msgEl) setPinState(btn, isBookmarked(msgEl.getAttribute('data-anchor')));
    });
}

function syncBookmarksForCurrent() {
    loadBookmarks();
}
