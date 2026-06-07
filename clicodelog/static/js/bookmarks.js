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
    allBookmarks.forEach(function (b) {
        if (b.session_id === currentSessionId && b.source === currentSource) {
            bookmarkSet[b.uuid || b.anchor] = b;
        }
    });
}

function loadBookmarks(cb) {
    fetch('/api/bookmarks')
        .then(function (r) { return r.json(); })
        .then(function (list) {
            allBookmarks = list || [];
            refreshBookmarkSet();
            if (cb) cb();
        })
        .catch(function () { if (cb) cb(); });
}

function toggleBookmark(msg, idx, anchor, btn) {
    if (isBookmarked(anchor)) {
        var b = bookmarkSet[anchor];
        fetch('/api/bookmarks/' + encodeURIComponent(b.id), { method: 'DELETE' })
            .then(function (r) { return r.json(); })
            .then(function (list) {
                allBookmarks = list || [];
                refreshBookmarkSet();
                btn.classList.remove('pinned');
                btn.textContent = '☆';
            });
        return;
    }
    var preview = (msg.content || '').trim().slice(0, 160) ||
        (msg.thinking ? '[thinking] ' + msg.thinking.slice(0, 140) : '') ||
        (msg.tool_uses && msg.tool_uses.length ? '[tool: ' + msg.tool_uses[0].name + ']' : '[no text]');
    var body = {
        source: currentSource,
        project_id: currentProjectId,
        session_id: currentSessionId,
        uuid: msg.uuid || null,
        anchor: anchor,
        msg_index: idx,
        role: msg.role,
        timestamp: msg.timestamp || null,
        preview: preview
    };
    fetch('/api/bookmarks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    })
        .then(function (r) { return r.json(); })
        .then(function (list) {
            allBookmarks = list || [];
            refreshBookmarkSet();
            btn.classList.add('pinned');
            btn.textContent = '★';
        });
}

function openBookmarksPanel() {
    loadBookmarks(function () { renderBookmarksPanel(); });
    var panel = document.getElementById('bookmarks-panel');
    if (panel) panel.classList.add('open');
}

function closeBookmarksPanel() {
    var panel = document.getElementById('bookmarks-panel');
    if (panel) panel.classList.remove('open');
}

function renderBookmarksPanel() {
    var list = document.getElementById('bookmarks-list');
    if (!list) return;
    list.textContent = '';
    if (!allBookmarks.length) {
        var empty = document.createElement('div');
        empty.className = 'bookmarks-empty';
        empty.textContent = 'No bookmarks yet. Click ☆ on any message to pin it.';
        list.appendChild(empty);
        return;
    }
    allBookmarks.forEach(function (b) {
        var item = document.createElement('div');
        item.className = 'bookmark-item';

        var meta = document.createElement('div');
        meta.className = 'bookmark-meta';
        var proj = (b.project_id || '').replace(/-/g, '/').replace(/^\//, '').split('/').slice(-1)[0];
        meta.textContent = (b.role || '') + ' · ' + proj + ' · ' + (b.session_id || '').slice(0, 8);
        item.appendChild(meta);

        var prev = document.createElement('div');
        prev.className = 'bookmark-preview';
        prev.textContent = b.preview || '(no preview)';
        item.appendChild(prev);

        item.onclick = function () { gotoBookmark(b); };

        var del = document.createElement('button');
        del.className = 'bookmark-del';
        del.textContent = '✕';
        del.title = 'Remove bookmark';
        del.onclick = function (e) {
            e.stopPropagation();
            fetch('/api/bookmarks/' + encodeURIComponent(b.id), { method: 'DELETE' })
                .then(function (r) { return r.json(); })
                .then(function (l) { allBookmarks = l || []; refreshBookmarkSet(); renderBookmarksPanel(); });
        };
        item.appendChild(del);

        list.appendChild(item);
    });
}

function scrollToAnchor(anchor) {
    var el = document.querySelector('.message[data-anchor="' + (window.CSS && CSS.escape ? CSS.escape(anchor) : anchor) + '"]');
    if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('bookmark-flash');
        setTimeout(function () { el.classList.remove('bookmark-flash'); }, 1600);
        return true;
    }
    return false;
}

function gotoBookmark(b) {
    closeBookmarksPanel();
    var anchor = b.uuid || b.anchor;
    var sameConv = (b.session_id === currentSessionId && b.source === currentSource);

    function findAfterLoad() {
        // Ensure all messages are rendered, then scroll to the anchor.
        if (typeof loadAllMessages === 'function') {
            loadAllMessages(function () {
                requestAnimationFrame(function () { scrollToAnchor(anchor); });
            });
        } else {
            scrollToAnchor(anchor);
        }
    }

    if (sameConv) {
        findAfterLoad();
        return;
    }
    // Different conversation: open via focus view in a new tab (works on both
    // main app and focus page), anchored.
    var url = '/view/' + encodeURIComponent(b.source) + '/' +
        encodeURIComponent(b.project_id) + '/' + encodeURIComponent(b.session_id) +
        '?anchor=' + encodeURIComponent(anchor);
    // Main app uses /view?source=...&project=...&session=...; build that form:
    url = '/view?source=' + encodeURIComponent(b.source) +
        '&project=' + encodeURIComponent(b.project_id) +
        '&session=' + encodeURIComponent(b.session_id) +
        '&anchor=' + encodeURIComponent(anchor);
    window.open(url, '_blank', 'noopener');
}

// Load bookmark set whenever a conversation is shown (called from renderConversation).
function syncBookmarksForCurrent() {
    loadBookmarks();
}
