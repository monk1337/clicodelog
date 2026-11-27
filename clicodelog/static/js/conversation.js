// Conversation toolbar: role chips, tool and thinking visibility, order, date
// range, jump to the ends, and find-in-conversation.
//
// Every control here changes the display model (buildView in conv-data.js)
// and rebuilds the virtual list around the message the reader is looking at,
// so a filter change never throws the reader back to the top.

var HIDE_TOOLS_KEY = 'clicodelog-hide-tools';
var ORDER_KEY = 'clicodelog-order';

(function restorePrefs() {
    try {
        var hide = localStorage.getItem(HIDE_TOOLS_KEY);
        if (hide !== null) document.body.classList.toggle('hide-tool-boxes', hide === '1');
        var order = localStorage.getItem(ORDER_KEY);
        if (order === 'oldest' || order === 'newest') msgOrder = order;
    } catch (e) { /* private mode */ }
})();

function refreshView(opts) {
    if (!currentConversation) return;
    buildView();
    vlRebuild(opts);
    updateConvStatus();
    if (convSearchQuery) recomputeFind(false);
}

function setSwitch(id, on) {
    var b = document.getElementById(id);
    if (!b) return;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
}

function syncToolbarState() {
    document.querySelectorAll('.role-btn').forEach(function(b) {
        var on = activeFilters.has(b.dataset.filter);
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    setSwitch('thinking-toggle-btn', allThinkingExpanded);
    setSwitch('tools-toggle-btn', !document.body.classList.contains('hide-tool-boxes'));
    var order = document.getElementById('msg-order-btn');
    if (order) {
        var label = order.querySelector('.label') || order;
        label.textContent = msgOrder === 'newest' ? 'Newest first' : 'Oldest first';
    }
    if (typeof syncUniqueToggles === 'function') syncUniqueToggles();
    var from = document.getElementById('date-from'), to = document.getElementById('date-to');
    if (from && dateFromFilter == null) from.value = '';
    if (to && dateToFilter == null) to.value = '';
    var viewBtn = document.getElementById('view-menu-btn');
    if (viewBtn) viewBtn.classList.toggle('has-filter', dateFromFilter != null || dateToFilter != null);
}

function toggleRoleFilter(filter) {
    if (activeFilters.has(filter)) activeFilters.delete(filter);
    else activeFilters.add(filter);
    syncToolbarState();
    refreshView();
}

function toggleToolBoxes() {
    var hidden = document.body.classList.toggle('hide-tool-boxes');
    try { localStorage.setItem(HIDE_TOOLS_KEY, hidden ? '1' : '0'); } catch (e) { /* ignore */ }
    syncToolbarState();
    refreshView();
}

function toggleAllThinking() {
    allThinkingExpanded = !allThinkingExpanded;
    if (currentConversation) {
        currentConversation.messages.forEach(function(m) { if (m._think !== undefined) delete m._think; });
    }
    document.querySelectorAll('.thinking-block').forEach(function(b) {
        b.classList.toggle('expanded', allThinkingExpanded);
    });
    syncToolbarState();
}

function toggleMsgOrder() {
    msgOrder = msgOrder === 'newest' ? 'oldest' : 'newest';
    try { localStorage.setItem(ORDER_KEY, msgOrder); } catch (e) { /* ignore */ }
    syncToolbarState();
    if (!currentConversation) return;
    // The loaded window may not reach the end the new order starts from.
    if (msgOrder === 'newest' ? hasNewerOnServer() : hasOlderOnServer()) {
        reloadConversationWindow();
        return;
    }
    buildView();
    vlRebuild({ scrollTo: 'top' });
    updateConvStatus();
}

async function reloadConversationWindow() {
    if (!currentProjectId || !currentSessionId) return;
    var seq = ++sessionRequestSeq;
    setConvBusy('Loading…');
    try {
        var r = await fetch(conversationUrl('limit=' + CONV_PAGE +
            (msgOrder === 'newest' ? '&tail=true' : '&offset=0')));
        if (seq !== sessionRequestSeq) return;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var conv = await r.json();
        if (seq !== sessionRequestSeq) return;
        if (!conv || conv.error || !Array.isArray(conv.messages)) throw new Error('bad payload');
        cachePut(cacheKeyFor(currentSource, currentProjectId, currentSessionId), conv);
        renderConversation(conv, { keepFilters: true });
    } catch (e) {
        if (seq !== sessionRequestSeq) return;
        showConvError('Could not reload this conversation.', reloadConversationWindow);
    } finally {
        if (seq === sessionRequestSeq) setConvBusy('');
    }
}

function readDateInput(id, endOfDay) {
    var el = document.getElementById(id);
    if (!el || !el.value) return null;
    var d = new Date(el.value + (endOfDay ? 'T23:59:59.999' : 'T00:00:00'));
    return isNaN(d) ? null : d.getTime();
}

function applyDateFilter() {
    dateFromFilter = readDateInput('date-from', false);
    dateToFilter = readDateInput('date-to', true);
    closeMenus();
    syncToolbarState();
    refreshView({ scrollTo: 'top' });
}

function clearDateFilter() {
    dateFromFilter = dateToFilter = null;
    syncToolbarState();
    refreshView();
}

function scrollConvToTop() { vlScrollToEdge('top'); }
function scrollConvToBottom() { vlScrollToEdge('bottom'); }

// ---------------------------------------------------------------- find
var findTimer = null;

function resetConvSearchState() {
    convSearchQuery = '';
    convSearchMatches = [];
    convSearchIndex = -1;
    convSearchSet = new Set();
    convSearchCurrentId = null;
    var input = document.getElementById('conv-search-input');
    if (input) input.value = '';
    clearFindHighlights();
    updateConvSearchStatus();
}

function onFindInput() {
    clearTimeout(findTimer);
    findTimer = setTimeout(runConvSearch, 250);
}

function onFindKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) convSearchPrev(); else convSearchNext(); }
    else if (e.key === 'Escape') { e.preventDefault(); clearConvSearch(); e.target.blur(); }
}

function runConvSearch() {
    clearTimeout(findTimer);
    var input = document.getElementById('conv-search-input');
    var q = (input ? input.value : '').trim().toLowerCase();
    if (!q) { clearConvSearch(); return; }
    convSearchQuery = q;
    recomputeFind(true);
}

// Matches are message ids in display order, so they stay valid while pages
// arrive and positions shift.
function recomputeFind(jump) {
    var q = convSearchQuery;
    convSearchMatches = [];
    convSearchSet = new Set();
    for (var p = 0; p < convView.length; p++) {
        if (messageText(convView[p]).indexOf(q) !== -1) {
            convSearchMatches.push(convView[p]._i);
            convSearchSet.add(convView[p]._i);
        }
    }
    var keep = convSearchMatches.indexOf(convSearchCurrentId);
    if (jump) {
        convSearchIndex = -1;
        convSearchCurrentId = null;
        if (convSearchMatches.length) { gotoConvMatch(0); return; }
    } else {
        convSearchIndex = keep;
        if (keep < 0) convSearchCurrentId = null;
    }
    vlRedecorate();
    applyFindHighlights();
    updateConvSearchStatus();
}

function gotoConvMatch(i) {
    var n = convSearchMatches.length;
    if (!n) return;
    convSearchIndex = ((i % n) + n) % n;
    convSearchCurrentId = convSearchMatches[convSearchIndex];
    vlRedecorate();
    vlScrollToId(convSearchCurrentId, 'center', applyFindHighlights);
    updateConvSearchStatus();
}

function convSearchNext() {
    var input = document.getElementById('conv-search-input');
    var q = (input ? input.value : '').trim().toLowerCase();
    if (q !== convSearchQuery || !convSearchMatches.length) { runConvSearch(); return; }
    gotoConvMatch(convSearchIndex + 1);
}

function convSearchPrev() {
    var input = document.getElementById('conv-search-input');
    var q = (input ? input.value : '').trim().toLowerCase();
    if (q !== convSearchQuery || !convSearchMatches.length) { runConvSearch(); return; }
    gotoConvMatch(convSearchIndex - 1);
}

function clearConvSearch() {
    resetConvSearchState();
    vlRedecorate();
}

function updateConvSearchStatus() {
    var el = document.getElementById('conv-search-status');
    if (!el) return;
    el.textContent = '';
    if (!convSearchQuery) return;
    var n = convSearchMatches.length;
    el.appendChild(document.createTextNode(n
        ? (convSearchIndex + 1) + ' of ' + n.toLocaleString()
        : 'No matches'));
    if (hasMoreOnServer()) {
        // Find covers what is loaded; say so, and offer the rest.
        var all = document.createElement('button');
        all.className = 'link-btn';
        all.textContent = 'Search all';
        all.title = 'Load the whole conversation and search all of it';
        all.onclick = function() { loadAllMessages(function() { recomputeFind(true); }); };
        el.appendChild(document.createTextNode(' · '));
        el.appendChild(all);
    }
}

// In-text highlighting with the CSS Custom Highlight API: ranges over the
// rendered text, styled by ::highlight(), with no DOM changes at all.
function clearFindHighlights() {
    if (window.CSS && CSS.highlights) {
        CSS.highlights.delete('conv-find');
        CSS.highlights.delete('conv-find-current');
    }
}

function applyFindHighlights() {
    if (!window.CSS || !CSS.highlights || typeof Highlight === 'undefined') return;
    if (!convSearchQuery || !VL || !convSearchSet.size) { clearFindHighlights(); return; }
    var all = new Highlight(), cur = new Highlight();
    var q = convSearchQuery, ql = q.length;
    VL.nodes.forEach(function(wrap, id) {
        if (!convSearchSet.has(id)) return;
        var target = id === convSearchCurrentId ? cur : all;
        var walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT);
        var node;
        while ((node = walker.nextNode())) {
            var text = node.nodeValue.toLowerCase();
            var at = text.indexOf(q);
            while (at !== -1) {
                try {
                    var r = new Range();
                    r.setStart(node, at);
                    r.setEnd(node, Math.min(at + ql, node.nodeValue.length));
                    target.add(r);
                } catch (e) { /* case mapping changed the length; skip */ }
                at = text.indexOf(q, at + ql);
            }
        }
    });
    CSS.highlights.set('conv-find', all);
    CSS.highlights.set('conv-find-current', cur);
}

// Called by the virtual list whenever the rendered window changes.
function onListRendered() {
    if (convSearchQuery) applyFindHighlights();
}
