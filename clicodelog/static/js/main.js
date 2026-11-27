// Main page wiring: inputs, keyboard shortcuts, startup.

document.getElementById('project-search').addEventListener('input', function() {
    renderProjects(filteredProjects());
});

// Shortcuts shared with the focus page live in installShortcuts (keys.js).
installShortcuts();

async function init() {
    await loadSources();

    // These only need currentSource, so they don't queue behind the projects.
    await Promise.all([
        loadProjects(),
        loadTagFilters(),
        fetchSyncStatus(),
    ]);

    var route = currentRoute();
    if (route.project) {
        await applyRoute(route);
    } else {
        pushRoute(true);
    }

    loadBookmarks();
    pollSearchIndexStatus();
}

init();
