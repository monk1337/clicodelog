function applySessionFilters() {
    var sizeFilter = document.getElementById('filter-size').value;
    var dateFilter = document.getElementById('filter-date').value;
    var sortFilter = document.getElementById('filter-sort').value;
    var filtered = currentSessions.slice();

    if (sizeFilter !== 'all') {
        filtered = filtered.filter(function(s) {
            var sz = s.size || 0;
            if (sizeFilter === '<10KB') return sz < 10240;
            if (sizeFilter === '10-100KB') return sz >= 10240 && sz < 102400;
            if (sizeFilter === '100KB-1MB') return sz >= 102400 && sz < 1048576;
            if (sizeFilter === '>1MB') return sz >= 1048576;
            return true;
        });
    }

    if (dateFilter !== 'all') {
        var now = new Date();
        var startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        var startOfWeek = new Date(startOfDay);
        startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
        var startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        filtered = filtered.filter(function(s) {
            var ts = s.last_timestamp || s.first_timestamp;
            if (!ts) return dateFilter === 'older';
            var d = new Date(ts);
            if (dateFilter === 'today') return d >= startOfDay;
            if (dateFilter === 'week') return d >= startOfWeek;
            if (dateFilter === 'month') return d >= startOfMonth;
            if (dateFilter === 'older') return d < startOfMonth;
            return true;
        });
    }

    if (sortFilter === 'newest') filtered.sort(function(a, b) { return new Date(b.last_timestamp || 0) - new Date(a.last_timestamp || 0); });
    else if (sortFilter === 'oldest') filtered.sort(function(a, b) { return new Date(a.last_timestamp || 0) - new Date(b.last_timestamp || 0); });
    else if (sortFilter === 'largest') filtered.sort(function(a, b) { return (b.size || 0) - (a.size || 0); });
    else if (sortFilter === 'messages') filtered.sort(function(a, b) { return (b.message_count || 0) - (a.message_count || 0); });

    renderSessions(filtered);
}

function resetSessionFilters() {
    document.getElementById('filter-size').value = 'all';
    document.getElementById('filter-date').value = 'all';
    document.getElementById('filter-sort').value = 'newest';
    applySessionFilters();
}

function renderSessions(sessions) {
    var container = document.getElementById('sessions-list');
    container.textContent = '';
    if (sessions.length === 0) { container.appendChild(emptyState('', 'No sessions found')); return; }
    var frag = document.createDocumentFragment();
    sessions.forEach(function(session) {
        frag.appendChild(buildSessionItem(session, false));
    });
    container.appendChild(frag);

    // Say plainly when the project holds more than has been fetched, rather
    // than looking like the list simply ends here.
    if (sessionTotal > currentSessions.length) {
        var footer = document.createElement('div');
        footer.className = 'sessions-footer';
        var label = document.createElement('span');
        label.textContent = 'Showing ' + currentSessions.length +
            ' of ' + sessionTotal.toLocaleString();
        var btn = document.createElement('button');
        btn.id = 'load-more-sessions';
        btn.className = 'retry-btn';
        btn.textContent = 'Load ' + Math.min(SESSION_PAGE, sessionTotal - currentSessions.length) + ' more';
        btn.onclick = loadMoreSessions;
        footer.appendChild(label);
        footer.appendChild(btn);
        container.appendChild(footer);
    }
}

// Selection used to call applySessionFilters(), rebuilding every node in a
// list that can hold 10,000+ sessions purely to move one CSS class — and
// destroying any expanded subagent panels on the way.
function markActiveSession(sessionId) {
    var container = document.getElementById('sessions-list');
    if (!container) return;
    container.querySelectorAll('.list-item.active').forEach(function(el) {
        el.classList.remove('active');
    });
    var next = container.querySelector('.list-item[data-session-id="' + CSS.escape(sessionId) + '"]');
    if (next) next.classList.add('active');
}

function buildSessionItem(session, isSubagent) {
    var item = document.createElement('div');
    item.className = 'list-item' + (session.id === currentSessionId ? ' active' : '') + (isSubagent ? ' subagent-item' : '');
    item.dataset.sessionId = session.id;
    item.onclick = function() { selectSession(session.id); };

    var title = document.createElement('div');
    title.className = 'list-item-title';
    if (isSubagent) {
        var arrow = document.createElement('span');
        arrow.className = 'subagent-arrow';
        arrow.textContent = '↳ ';
        title.appendChild(arrow);
    }
    title.appendChild(document.createTextNode(session.summary));

    var meta = document.createElement('div');
    meta.className = 'list-item-meta';
    meta.textContent = session.message_count + ' msgs • ' + formatSize(session.size);
    var tokens = totalTokens(session.usage && session.usage.input !== undefined
        ? {
            input_tokens: session.usage.input,
            output_tokens: session.usage.output,
            cache_read_input_tokens: session.usage.cache_read,
            cache_creation_input_tokens: session.usage.cache_creation,
        }
        : session.usage);
    if (tokens) meta.textContent += ' • ' + formatTokens(tokens) + ' tok';
    meta.appendChild(document.createElement('br'));
    meta.appendChild(document.createTextNode(formatTime(session.last_timestamp)));

    if (!isSubagent && session.subagent_count > 0) {
        var badge = document.createElement('span');
        badge.className = 'subagent-badge';
        badge.textContent = '⚡ ' + session.subagent_count + ' sub';
        badge.title = 'Expand sub-agents';
        badge.onclick = function(e) {
            e.stopPropagation();
            toggleSubagents(session.id, item);
        };
        meta.appendChild(document.createTextNode(' '));
        meta.appendChild(badge);
    }

    item.appendChild(title);
    item.appendChild(meta);
    return item;
}

async function toggleSubagents(sessionId, parentItem) {
    var existing = document.getElementById('subagents-' + sessionId);
    if (existing) { existing.remove(); return; }
    var wrapper = document.createElement('div');
    wrapper.id = 'subagents-' + sessionId;
    wrapper.appendChild(loadingSpinner('Loading sub-agents...'));
    parentItem.insertAdjacentElement('afterend', wrapper);
    try {
        var r = await fetch('/api/projects/' + encodeURIComponent(currentProjectId) +
            '/sessions/' + encodeURIComponent(sessionId) +
            '/subagents?source=' + encodeURIComponent(currentSource));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var subs = await r.json();
        wrapper.textContent = '';
        if (!subs.length) { wrapper.appendChild(emptyState('', 'No sub-agents found')); return; }
        subs.forEach(function(s) { wrapper.appendChild(buildSessionItem(s, true)); });
    } catch (e) {
        wrapper.textContent = '';
        wrapper.appendChild(emptyState('', 'Could not load sub-agents'));
    }
}

async function selectSession(sessionId, opts) {
    opts = opts || {};
    currentSessionId = sessionId;
    markActiveSession(sessionId);
    if (!suppressRouting && typeof pushRoute === 'function') pushRoute();

    var key = cacheKeyFor(currentSource, currentProjectId, sessionId);
    var cached = cacheGet(key);
    if (cached) {
        try {
            renderConversation(cached);
            if (opts.anchor) jumpToAnchor(opts.anchor);
        } catch (e) {
            // The cache-hit path used to sit outside try/catch, so a bad entry
            // threw uncaught and the pane stayed stale forever.
            console.error('Render failed from cache:', e);
            conversationCache.delete(key);
            setPanel('conversation-content', errorState('Could not render this conversation.',
                function() { selectSession(sessionId, opts); }));
        }
        return;
    }

    var seq = ++sessionRequestSeq;
    setPanel('conversation-content', loadingSpinner('Loading conversation...'));

    try {
        // Ask for a window. Without a limit the server parses the whole file:
        // 604 MB of RSS and a 138 MB response for the largest session here.
        // Newest-first is the default view, so fetch the END of the session —
        // fetching offset 0 and reversing it showed the oldest messages under
        // a "Newest first" label, which on a long session looks like the
        // recent conversation is missing entirely.
        var url = '/api/projects/' + encodeURIComponent(currentProjectId) +
            '/sessions/' + encodeURIComponent(sessionId) +
            '?source=' + encodeURIComponent(currentSource) +
            '&limit=' + CONV_PAGE +
            (msgOrder === 'newest' ? '&tail=true' : '');
        var r = await fetch(url);

        // Click a big session, then a small one: the big response can land last
        // and replace the pane while the list shows the other as selected.
        if (seq !== sessionRequestSeq) return;

        var conv = null;
        try { conv = await r.json(); } catch (e) { conv = null; }
        if (seq !== sessionRequestSeq) return;

        if (!r.ok || !conv || conv.error || !Array.isArray(conv.messages)) {
            var msg = (conv && conv.error) || ('Could not load this conversation (HTTP ' + r.status + ')');
            setPanel('conversation-content', errorState(msg, function() {
                selectSession(sessionId, opts);
            }));
            return;                       // deliberately NOT cached
        }

        cachePut(key, conv);
        renderConversation(conv);
        if (opts.anchor) jumpToAnchor(opts.anchor);
    } catch (e) {
        if (seq !== sessionRequestSeq) return;
        setPanel('conversation-content', errorState('Could not load this conversation.',
            function() { selectSession(sessionId, opts); }));
    }
}

function jumpToAnchor(uuid) {
    if (!uuid) return;
    // Already on screen? Just scroll.
    if (scrollToAnchor(uuid)) return;
    // Otherwise fetch a window centred on it rather than loading the whole
    // session to reach one message.
    if (typeof openAtAnchor === 'function') {
        openAtAnchor(uuid);
    } else if (typeof loadAllMessages === 'function') {
        loadAllMessages(function() { scrollToAnchor(uuid); });
    }
}
