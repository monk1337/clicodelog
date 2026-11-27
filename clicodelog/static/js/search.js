// Global search dialog (⌘K). Results stay on screen while the next query runs,
// so typing never flashes a spinner, and recent answers are kept in a small
// cache so deleting a character back to an earlier query is instant.

var searchResults = [];
var searchActiveIndex = -1;
var searchCache = new Map();         // source + query -> response
var SEARCH_CACHE_MAX = 30;

function toggleSearch(force) {
    var modal = document.getElementById('search-modal');
    if (!modal) return;
    var open = typeof force === 'boolean' ? force : !modal.classList.contains('active');
    modal.classList.toggle('active', open);
    var btn = document.getElementById('search-btn');
    if (btn) btn.classList.toggle('active', open);
    var input = document.getElementById('global-search-input');
    if (open) {
        closeMenus();
        if (input) { input.focus(); input.select(); }
        if (!input || !input.value) showSearchHint();
    } else if (searchAbort) {
        searchAbort.abort();          // stop work the user walked away from
        searchAbort = null;
    }
}

function showSearchHint() {
    var el = document.getElementById('search-results');
    if (!el) return;
    el.textContent = '';
    el.appendChild(noResults('Search titles, paths and — once the index is built — every message.'));
    searchResults = [];
}

function setSearchBusy(on) {
    var bar = document.getElementById('search-progress');
    if (bar) bar.hidden = !on;
}

async function searchConversations(query) {
    query = (query || '').trim();
    if (query.length < 2) {
        if (searchAbort) { searchAbort.abort(); searchAbort = null; }
        setSearchBusy(false);
        if (!query) showSearchHint();
        else {
            var el = document.getElementById('search-results');
            el.textContent = '';
            el.appendChild(noResults('Keep typing…'));
            searchResults = [];
        }
        return;
    }

    var key = currentSource + '␟' + query;
    if (searchCache.has(key)) {
        renderSearchResults(searchCache.get(key), query);
        return;
    }

    // Cancel the in-flight request: a slow earlier query must not resolve
    // after a fast later one and overwrite the right results.
    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();
    var seq = ++searchRequestSeq;
    setSearchBusy(true);
    try {
        var r = await fetch('/api/search?q=' + encodeURIComponent(query) +
            '&source=' + encodeURIComponent(currentSource), { signal: searchAbort.signal });
        if (seq !== searchRequestSeq) return;          // superseded
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var data = await r.json();
        if (seq !== searchRequestSeq) return;
        searchCache.set(key, data);
        while (searchCache.size > SEARCH_CACHE_MAX) searchCache.delete(searchCache.keys().next().value);
        renderSearchResults(data, query);
    } catch (e) {
        if (e.name === 'AbortError' || seq !== searchRequestSeq) return;
        var box = document.getElementById('search-results');
        box.textContent = '';
        box.appendChild(noResults('Search failed. Is the server running?'));
    } finally {
        if (seq === searchRequestSeq) setSearchBusy(false);
    }
}

function renderSearchResults(data, query) {
    var el = document.getElementById('search-results');
    var results = (data && data.results) || [];
    searchResults = results;
    searchActiveIndex = results.length ? 0 : -1;
    el.textContent = '';

    if (results.length === 0) {
        el.appendChild(noResults('No results for “' + query + '”'));
        if (data && data.content_search === false) {
            var hint = document.createElement('div');
            hint.className = 'search-status';
            hint.textContent = 'Only titles and paths are searchable right now. ' +
                'Build the full-text index below to search inside conversations.';
            el.appendChild(hint);
        }
        return;
    }
    var totalMatches = results.reduce(function(n, r) { return n + (r.match_count || 0); }, 0);
    var status = document.createElement('div');
    status.className = 'search-status';
    status.textContent = results.length + (results.length === 1 ? ' conversation' : ' conversations') +
        (totalMatches ? ' · ' + totalMatches.toLocaleString() + ' matching messages' : '') +
        (data.content_search ? '' : ' · titles only');
    el.appendChild(status);

    var frag = document.createDocumentFragment();
    results.forEach(function(result, i) { frag.appendChild(buildSearchResult(result, i)); });
    el.appendChild(frag);
    paintSearchSelection();
}

function buildSearchResult(result, index) {
    var item = document.createElement('div');
    item.className = 'search-result-item';
    item.dataset.index = String(index);
    item.setAttribute('role', 'option');
    item.onclick = function() { openSearchResult(index); };
    item.onmousemove = function() {
        if (searchActiveIndex !== index) { searchActiveIndex = index; paintSearchSelection(true); }
    };

    var head = document.createElement('div');
    head.className = 'search-result-head';
    head.appendChild(icon('chat', 'search-result-icon'));
    var title = document.createElement('div');
    title.className = 'search-result-title';
    title.textContent = result.summary || ('Session ' + String(result.session_id).slice(0, 8));
    head.appendChild(title);
    if (result.last_ts) {
        var when = document.createElement('span');
        when.className = 'search-result-time';
        when.textContent = relativeTime(result.last_ts);
        when.title = formatTime(result.last_ts);
        head.appendChild(when);
    }
    item.appendChild(head);

    var meta = document.createElement('div');
    meta.className = 'search-result-meta';
    var bits = [];
    if (result.cwd || result.project_name) bits.push(shortPath(result.cwd || result.project_name));
    if (result.match_count) bits.push(result.match_count + (result.match_count === 1 ? ' match' : ' matches'));
    meta.textContent = bits.join('  ·  ');
    item.appendChild(meta);

    (result.matches || []).forEach(function(m) { item.appendChild(buildSnippet(m, index)); });
    return item;
}

function buildSnippet(match, resultIndex) {
    var row = document.createElement('div');
    row.className = 'search-snippet';
    row.title = 'Open at this message';

    var role = document.createElement('span');
    role.className = 'search-snippet-role ' + (match.role === 'user' ? 'is-user' : 'is-assistant');
    role.textContent = match.role === 'user' ? 'You' : (match.role === 'assistant' ? 'AI' : (match.role || ''));
    row.appendChild(role);

    var text = document.createElement('span');
    text.className = 'search-snippet-text';
    // snippet_parts is [{t, hit}]; <mark> nodes via createElement keep the
    // no-innerHTML-with-dynamic-data rule intact.
    (match.snippet_parts || []).forEach(function(part) {
        if (part.hit) {
            var mark = document.createElement('mark');
            mark.textContent = part.t;
            text.appendChild(mark);
        } else {
            text.appendChild(document.createTextNode(part.t));
        }
    });
    row.appendChild(text);

    row.onclick = function(e) {
        e.stopPropagation();
        openSearchResult(resultIndex, match.uuid);   // straight to the message
    };
    return row;
}

function paintSearchSelection(noScroll) {
    var items = document.querySelectorAll('#search-results .search-result-item');
    items.forEach(function(node, i) {
        var on = i === searchActiveIndex;
        node.classList.toggle('active', on);
        node.setAttribute('aria-selected', on ? 'true' : 'false');
        if (on && !noScroll) node.scrollIntoView({ block: 'nearest' });
    });
}

function moveSearchSelection(delta) {
    if (!searchResults.length) return;
    var next = searchActiveIndex + delta;
    if (next < 0) next = searchResults.length - 1;
    if (next >= searchResults.length) next = 0;
    searchActiveIndex = next;
    paintSearchSelection();
}

function openSearchResult(index, anchorUuid) {
    var result = searchResults[index >= 0 ? index : searchActiveIndex];
    if (!result) return;
    // Enter on a result with content matches lands on its best match.
    if (!anchorUuid && result.matches && result.matches.length && result.matches[0].uuid) {
        anchorUuid = result.matches[0].uuid;
    }
    toggleSearch(false);
    selectSearchResult(result.project_id, result.session_id, anchorUuid);
}

async function selectSearchResult(projectId, sessionId, anchorUuid) {
    currentProjectId = projectId;
    currentSessionId = sessionId;
    markActiveProject(projectId);
    // The conversation does not depend on the session list; load both at once.
    await Promise.all([
        selectProject(projectId, { keepSession: true }),
        selectSession(sessionId, { anchor: anchorUuid }),
    ]);
}

(function wireSearchInput() {
    var input = document.getElementById('global-search-input');
    if (!input) return;
    input.addEventListener('input', function(e) {
        clearTimeout(searchTimeout);
        var query = e.target.value;
        // Indexed queries are fast; the debounce dominates perceived latency.
        searchTimeout = setTimeout(function() { searchConversations(query); }, 120);
    });
    input.addEventListener('keydown', function(e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); moveSearchSelection(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); moveSearchSelection(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); openSearchResult(-1); }
    });
    var modal = document.getElementById('search-modal');
    if (modal) modal.addEventListener('mousedown', function(e) { if (e.target === modal) toggleSearch(false); });
})();
