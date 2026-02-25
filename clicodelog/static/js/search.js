var searchTimeout = null;

function toggleSearch() {
    var modal = document.getElementById('search-modal');
    var btn = document.getElementById('search-btn');
    var active = modal.classList.toggle('active');
    btn.classList.toggle('active', active);
    if (active) document.getElementById('global-search-input').focus();
}

async function searchConversations(query) {
    var el = document.getElementById('search-results');
    if (!query || query.length < 2) {
        el.textContent = '';
        el.appendChild(noResults('Type at least 2 characters to search'));
        return;
    }
    el.textContent = '';
    el.appendChild(loadingSpinner('Searching...'));
    try {
        var results = await fetch('/api/search?q=' + encodeURIComponent(query) + '&source=' + currentSource).then(function(r) { return r.json(); });
        el.textContent = '';
        if (results.length === 0) { el.appendChild(noResults('No results found')); return; }
        results.forEach(function(result) {
            var item = document.createElement('div');
            item.className = 'search-result-item';
            item.onclick = function() { selectSearchResult(result.project_id, result.session_id); };
            var title = document.createElement('div');
            title.className = 'search-result-title';
            title.textContent = result.session_id;
            var meta = document.createElement('div');
            meta.className = 'search-result-meta';
            meta.textContent = result.project_name;
            item.appendChild(title);
            item.appendChild(meta);
            el.appendChild(item);
        });
    } catch (e) {
        el.textContent = '';
        el.appendChild(noResults('Search failed'));
    }
}

async function selectSearchResult(projectId, sessionId) {
    toggleSearch();
    currentProjectId = projectId;
    currentSessionId = sessionId;
    await selectProject(projectId);
    await selectSession(sessionId);
}
