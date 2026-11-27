// Keyboard shortcuts, shared by the main page and the focus view.
//
//   ⌘K / Ctrl+K   search every conversation
//   ⌘F / Ctrl+F   find in this conversation (press again for the browser's)
//   /             find in this conversation
//   Esc           close whatever is open
//
// ⌘F is taken over because the list is virtual: the browser's own find only
// sees the few messages that are rendered. Pressing it a second time while our
// find field is focused falls through to the browser.

function focusConvFind() {
    var input = document.getElementById('conv-search-input');
    var bar = document.getElementById('conv-filter-bar');
    if (!input || !bar || bar.hidden) return false;
    input.focus();
    input.select();
    return true;
}

function closeTopLayer() {
    var search = document.getElementById('search-modal');
    if (search && search.classList.contains('active')) { toggleSearch(false); return true; }
    var stats = document.getElementById('stats-modal');
    if (stats && stats.classList.contains('active')) { toggleStats(false); return true; }
    if (document.querySelector('.menu.open')) { closeMenus(); return true; }
    var bm = document.getElementById('bookmarks-panel');
    if (bm && bm.classList.contains('open')) { closeBookmarksPanel(); return true; }
    if (document.body.classList.contains('nav-open')) { document.body.classList.remove('nav-open'); return true; }
    return false;
}

function installShortcuts() {
    document.addEventListener('keydown', function(e) {
        var mod = e.metaKey || e.ctrlKey;
        if (mod && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            toggleSearch();
            return;
        }
        if (mod && (e.key === 'f' || e.key === 'F') && !e.shiftKey && !e.altKey) {
            var input = document.getElementById('conv-search-input');
            if (document.activeElement !== input && focusConvFind()) e.preventDefault();
            return;
        }
        if (e.key === 'Escape') {
            if (closeTopLayer()) e.preventDefault();
            return;
        }
        if (e.key === '/' && !mod && !isTyping(e)) {
            if (focusConvFind()) e.preventDefault();
        }
    });
}
