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

    var t = function(s) { return Date.parse(s.last_timestamp) || 0; };
    if (sortFilter === 'newest') filtered.sort(function(a, b) { return t(b) - t(a); });
    else if (sortFilter === 'oldest') filtered.sort(function(a, b) { return t(a) - t(b); });
    else if (sortFilter === 'largest') filtered.sort(function(a, b) { return (b.size || 0) - (a.size || 0); });
    else if (sortFilter === 'messages') filtered.sort(function(a, b) { return (b.message_count || 0) - (a.message_count || 0); });

    var active = sizeFilter !== 'all' || dateFilter !== 'all' || sortFilter !== 'newest';
    var reset = document.getElementById('filter-reset');
    if (reset) reset.hidden = !active;
    renderSessions(filtered);
}

function resetSessionFilters() {
    document.getElementById('filter-size').value = 'all';
    document.getElementById('filter-date').value = 'all';
    document.getElementById('filter-sort').value = 'newest';
    applySessionFilters();
}

function setSessionsCount() {
    var c = document.getElementById('sessions-count');
    if (c) c.textContent = sessionTotal ? sessionTotal.toLocaleString() : '';
}

function renderSessions(sessions) {
    var container = document.getElementById('sessions-list');
    container.textContent = '';
    setSessionsCount();
    if (sessions.length === 0) { container.appendChild(emptyState('', 'No sessions match')); return; }
    var frag = document.createDocumentFragment();
    sessions.forEach(function(session) { frag.appendChild(buildSessionItem(session, false)); });
    container.appendChild(frag);

    // Say plainly when the project holds more than has been fetched, rather
    // than looking like the list simply ends here.
    if (sessionTotal > currentSessions.length) {
        var footer = document.createElement('div');
        footer.className = 'sessions-footer';
        var label = document.createElement('span');
        label.textContent = 'Showing ' + currentSessions.length.toLocaleString() +
            ' of ' + sessionTotal.toLocaleString();
        var btn = document.createElement('button');
        btn.id = 'load-more-sessions';
        btn.className = 'btn btn-tonal';
        btn.textContent = 'Load ' + Math.min(SESSION_PAGE, sessionTotal - currentSessions.length) + ' more';
        btn.onclick = loadMoreSessions;
        footer.append(label, btn);
        container.appendChild(footer);
    }
}

// Selection used to rebuild every node in a list that can hold 10,000+
// sessions purely to move one CSS class.
function markActiveSession(sessionId) {
    var container = document.getElementById('sessions-list');
    if (!container) return;
    container.querySelectorAll('.list-item.active').forEach(function(el) { el.classList.remove('active'); });
    var next = container.querySelector('.list-item[data-session-id="' + CSS.escape(sessionId) + '"]');
    if (next) {
        next.classList.add('active');
        next.scrollIntoView({ block: 'nearest' });
    }
}

function sessionUsage(session) {
    var u = session.usage;
    if (u && u.input !== undefined) {
        return { input_tokens: u.input, output_tokens: u.output,
                 cache_read_input_tokens: u.cache_read, cache_creation_input_tokens: u.cache_creation };
    }
    return u;
}

function metaBit(iconName, text, title) {
    var s = document.createElement('span');
    s.className = 'meta-bit';
    if (iconName) s.appendChild(icon(iconName));
    s.appendChild(document.createTextNode(text));
    if (title) s.title = title;
    return s;
}

function buildSessionItem(session, isSubagent) {
    var item = document.createElement('div');
    item.className = 'list-item session-item' + (session.id === currentSessionId ? ' active' : '') +
        (isSubagent ? ' subagent-item' : '');
    item.dataset.sessionId = session.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.onclick = function() { selectSession(session.id); };
    item.onkeydown = function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSession(session.id); }
    };

    var top = document.createElement('div');
    top.className = 'item-top';
    var title = document.createElement('div');
    title.className = 'list-item-title';
    if (isSubagent) title.appendChild(icon('bolt', 'subagent-icon'));
    title.appendChild(document.createTextNode(session.summary === 'No summary'
        ? 'Session ' + String(session.id).slice(0, 8) : session.summary));
    title.title = session.summary;
    var when = document.createElement('time');
    when.className = 'item-time';
    when.textContent = relativeTime(session.last_timestamp);
    if (session.last_timestamp) when.title = formatTime(session.last_timestamp);
    top.append(title, when);

    var meta = document.createElement('div');
    meta.className = 'list-item-meta';
    meta.appendChild(metaBit('chat', (session.message_count || 0).toLocaleString()));
    meta.appendChild(metaBit('', formatSize(session.size)));
    var usage = sessionUsage(session);
    var tokens = totalTokens(usage);
    if (tokens) meta.appendChild(metaBit('', formatTokens(tokens) + ' tok', tokenBreakdown(usage)));

    if (!isSubagent && session.subagent_count > 0) {
        var badge = document.createElement('button');
        badge.className = 'subagent-badge';
        badge.appendChild(icon('bolt'));
        badge.appendChild(document.createTextNode(session.subagent_count + ' sub-agent' +
            (session.subagent_count === 1 ? '' : 's')));
        badge.title = 'Show sub-agents';
        badge.onclick = function(e) {
            e.stopPropagation();
            toggleSubagents(session.id, item, badge);
        };
        meta.appendChild(badge);
    }

    item.append(top, meta);
    return item;
}

async function toggleSubagents(sessionId, parentItem, badge) {
    var existing = document.getElementById('subagents-' + sessionId);
    if (existing) { existing.remove(); if (badge) badge.classList.remove('open'); return; }
    if (badge) badge.classList.add('open');
    var wrapper = document.createElement('div');
    wrapper.id = 'subagents-' + sessionId;
    wrapper.className = 'subagent-list';
    wrapper.appendChild(loadingSpinner('Loading sub-agents…'));
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
        ++sessionRequestSeq;
        try {
            renderConversation(cached);
            if (opts.anchor) jumpToAnchor(opts.anchor);
            return;
        } catch (e) {
            // A bad cache entry must not leave the pane stale forever.
            console.error('Render failed from cache:', e);
            conversationCache.delete(key);
        }
    }

    // With an anchor, open straight onto that message instead of the tail.
    if (opts.anchor) { await openAtAnchor(opts.anchor); return; }

    var seq = ++sessionRequestSeq;
    showConvLoading();
    try {
        // Ask for a window from the end the current order starts at. Without
        // a limit the server parses the whole file: 604 MB of RSS and a 138 MB
        // response for the largest session here.
        var r = await fetch(conversationUrl('limit=' + CONV_PAGE +
            (msgOrder === 'newest' ? '&tail=true' : '')));
        // Click a big session, then a small one: the big response can land
        // last and replace the pane while the list shows the other as selected.
        if (seq !== sessionRequestSeq) return;
        var conv = null;
        try { conv = await r.json(); } catch (e) { conv = null; }
        if (seq !== sessionRequestSeq) return;

        if (!r.ok || !conv || conv.error || !Array.isArray(conv.messages)) {
            var msg = (conv && conv.error) || ('Could not load this conversation (HTTP ' + r.status + ')');
            showConvError(msg, function() { selectSession(sessionId, opts); });
            return;                       // deliberately NOT cached
        }
        cachePut(key, conv);
        renderConversation(conv);
    } catch (e) {
        if (seq !== sessionRequestSeq) return;
        showConvError('Could not load this conversation.', function() { selectSession(sessionId, opts); });
    }
}

function jumpToAnchor(uuid) {
    if (!uuid) return;
    if (scrollToAnchor(uuid)) return;
    openAtAnchor(uuid);
}
