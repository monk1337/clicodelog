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
    sessions.forEach(function(session) {
        container.appendChild(buildSessionItem(session, false));
    });
}

function buildSessionItem(session, isSubagent) {
    var item = document.createElement('div');
    item.className = 'list-item' + (session.id === currentSessionId ? ' active' : '') + (isSubagent ? ' subagent-item' : '');
    item.onclick = function() { selectSession(session.id); };

    var title = document.createElement('div');
    title.className = 'list-item-title';
    if (isSubagent) {
        var arrow = document.createElement('span');
        arrow.className = 'subagent-arrow';
        arrow.textContent = '\u21B3 ';
        title.appendChild(arrow);
    }
    title.appendChild(document.createTextNode(session.summary));

    var meta = document.createElement('div');
    meta.className = 'list-item-meta';
    meta.textContent = session.message_count + ' msgs \u2022 ' + formatSize(session.size);
    var br = document.createElement('br');
    meta.appendChild(br);
    meta.appendChild(document.createTextNode(formatTime(session.last_timestamp)));

    if (!isSubagent && session.subagent_count > 0) {
        var badge = document.createElement('span');
        badge.className = 'subagent-badge';
        badge.textContent = '\u26A1 ' + session.subagent_count + ' sub';
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
        var subs = await fetch('/api/projects/' + currentProjectId + '/sessions/' + sessionId + '/subagents?source=' + currentSource).then(function(r) { return r.json(); });
        wrapper.textContent = '';
        if (subs.length === 0) { wrapper.appendChild(emptyState('', 'No sub-agents found')); return; }
        subs.forEach(function(s) { wrapper.appendChild(buildSessionItem(s, true)); });
    } catch (e) { wrapper.textContent = 'Error loading sub-agents'; }
}

async function selectSession(sessionId) {
    currentSessionId = sessionId;
    applySessionFilters();
    var cacheKey = currentProjectId + ':' + sessionId;
    if (conversationCache[cacheKey]) {
        renderConversation(conversationCache[cacheKey]);
        return;
    }
    setPanel('conversation-content', loadingSpinner('Loading conversation...'));
    try {
        var conv = await fetch('/api/projects/' + currentProjectId + '/sessions/' + sessionId + '?source=' + currentSource).then(function(r) { return r.json(); });
        conversationCache[cacheKey] = conv;
        renderConversation(conv);
    } catch (e) { setPanel('conversation-content', emptyState('', 'Error loading conversation')); }
}
