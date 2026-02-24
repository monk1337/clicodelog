document.getElementById('project-search').addEventListener('input', function(e) {
    var query = e.target.value.toLowerCase();
    renderProjects(projects.filter(function(p) {
        return p.name.toLowerCase().includes(query) ||
            (p.custom_name && p.custom_name.toLowerCase().includes(query)) ||
            (p.tags && p.tags.some(function(t) { return t.toLowerCase().includes(query); }));
    }));
});

document.getElementById('global-search-input').addEventListener('input', function(e) {
    clearTimeout(searchTimeout);
    var query = e.target.value;
    searchTimeout = setTimeout(function() { searchConversations(query); }, 300);
});

document.addEventListener('keydown', function(e) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        toggleSearch();
    }
    if (e.key === 'Escape') {
        var modal = document.getElementById('search-modal');
        if (modal && modal.classList.contains('active')) toggleSearch();
    }
});

async function init() {
    await loadSources();
    await loadProjects();
    await loadTagFilters();
}

init();
