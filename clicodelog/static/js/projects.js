async function loadSources() {
    try {
        const data = await fetch('/api/sources').then(r => r.json());
        availableSources = data.sources;
        currentSource = data.current;
        const select = document.getElementById('source-select');
        select.textContent = '';
        availableSources.forEach(function(s) {
            const opt = document.createElement('option');
            opt.value = s.id;
            opt.selected = s.id === currentSource;
            opt.disabled = !s.available;
            opt.textContent = s.name + (!s.available ? ' (not found)' : '');
            select.appendChild(opt);
        });
    } catch (e) { console.error('Error loading sources:', e); }
}

async function changeSource(sourceId) {
    if (sourceId === currentSource) return;
    currentSource = sourceId;
    currentProjectId = null;
    currentSessionId = null;
    document.getElementById('export-btn').disabled = true;
    document.getElementById('copy-btn').disabled = true;
    currentSessions = [];
    document.getElementById('session-filters').style.display = 'none';
    resetSessionFilters();
    activeTagFilter = null;
    conversationCache = {};
    document.getElementById('conv-filter-bar').style.display = 'none';
    setPanel('sessions-list', emptyState('📁', 'Select a project to view sessions'));
    setPanel('conversation-content', emptyState('💬', 'Select a session to view the conversation', 'AI Conversation History'));
    await loadProjects();
    await loadTagFilters();
    await fetchSyncStatus();
}

async function loadProjects() {
    try {
        projects = await fetch('/api/projects?source=' + currentSource).then(r => r.json());
        renderProjects(projects);
    } catch (e) { setPanel('projects-list', emptyState('', 'Error loading projects')); }
}

function renderProjects(projectsList) {
    const container = document.getElementById('projects-list');
    const filtered = activeTagFilter
        ? projectsList.filter(function(p) { return p.tags && p.tags.includes(activeTagFilter); })
        : projectsList;
    container.textContent = '';
    if (filtered.length === 0) { container.appendChild(emptyState('', 'No projects found')); return; }
    filtered.forEach(function(project) {
        const item = document.createElement('div');
        item.className = 'list-item' + (project.id === currentProjectId ? ' active' : '');
        item.onclick = function() { selectProject(project.id); };
        const editBtn = document.createElement('button');
        editBtn.className = 'edit-btn';
        editBtn.title = 'Edit name & tags';
        editBtn.textContent = '\u270E';
        editBtn.onclick = function(e) { e.stopPropagation(); openEditProject(project.id); };
        const title = document.createElement('div');
        title.className = 'list-item-title';
        title.textContent = project.custom_name || project.name;
        const meta = document.createElement('div');
        meta.className = 'list-item-meta';
        meta.textContent = project.session_count + ' sessions ';
        (project.tags || []).forEach(function(t) {
            const chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.style.background = tagColor(t);
            chip.textContent = t;
            meta.appendChild(chip);
        });
        item.appendChild(editBtn);
        item.appendChild(title);
        item.appendChild(meta);
        container.appendChild(item);
    });
}

async function openEditProject(projectId) {
    const project = projects.find(function(p) { return p.id === projectId; });
    if (!project) return;
    const newName = prompt('Custom project name (leave empty to use default):', project.custom_name || '');
    if (newName === null) return;
    const newTagsStr = prompt('Tags (comma-separated):', (project.tags || []).join(', '));
    if (newTagsStr === null) return;
    const newTags = newTagsStr.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
    try {
        await fetch('/api/projects/' + projectId + '/meta?source=' + currentSource, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ custom_name: newName, tags: newTags }),
        });
        await loadProjects();
        await loadTagFilters();
    } catch (e) { console.error('Error saving project metadata:', e); }
}

async function selectProject(projectId) {
    currentProjectId = projectId;
    currentSessionId = null;
    renderProjects(projects);
    document.getElementById('export-btn').disabled = true;
    document.getElementById('copy-btn').disabled = true;
    setPanel('sessions-list', loadingSpinner('Loading sessions...'));
    try {
        currentSessions = await fetch('/api/projects/' + projectId + '/sessions?source=' + currentSource).then(r => r.json());
        document.getElementById('session-filters').style.display = 'flex';
        applySessionFilters();
    } catch (e) { setPanel('sessions-list', emptyState('', 'Error loading sessions')); }
}
