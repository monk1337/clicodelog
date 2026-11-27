var projectRequestSeq = 0;

async function loadSources() {
    try {
        var data = await fetch('/api/sources').then(function(r) { return r.json(); });
        availableSources = data.sources;
        currentSource = data.current;
        var select = document.getElementById('source-select');
        select.textContent = '';
        availableSources.forEach(function(s) {
            var opt = document.createElement('option');
            opt.value = s.id;
            opt.selected = s.id === currentSource;
            opt.disabled = !s.available;
            var label = s.name;
            if (!s.available) label += ' — not found';
            else if (s.warning) label += ' — unreadable';
            opt.textContent = label;
            select.appendChild(opt);
        });
        // A source with files on disk but nothing readable means the vendor
        // changed format. Say so rather than showing an empty list.
        var broken = availableSources.filter(function(s) { return s.warning; });
        if (broken.length) showSourceWarning(broken);
    } catch (e) { console.error('Error loading sources:', e); }
}

function showSourceWarning(broken) {
    var bar = document.getElementById('source-warning');
    if (!bar) return;
    bar.textContent = broken.map(function(s) { return s.name; }).join(', ') +
        ': files found but none could be read. The log format may have changed.';
    bar.hidden = false;
}

async function changeSource(sourceId) {
    if (sourceId === currentSource) return;
    currentSource = sourceId;
    currentProjectId = null;
    currentSessionId = null;
    currentSessions = [];
    sessionTotal = 0;
    var filters = document.getElementById('session-filters');
    if (filters) filters.hidden = true;
    resetSessionFilters();
    activeTagFilter = null;
    cacheClear();
    setSessionsCount();
    setPanel('sessions-list', emptyState('folder', 'Select a project to see its sessions'));
    resetConversationPane();
    if (!suppressRouting && typeof pushRoute === 'function') pushRoute();
    await loadProjects();
    await loadTagFilters();
    await fetchSyncStatus();
}

async function loadProjects() {
    try {
        var r = await fetch('/api/projects?source=' + encodeURIComponent(currentSource));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        projects = await r.json();
        renderProjects(filteredProjects());
    } catch (e) {
        setPanel('projects-list', errorState('Could not load projects.', loadProjects));
    }
}

function filteredProjects() {
    var input = document.getElementById('project-search');
    var q = input ? input.value.trim().toLowerCase() : '';
    if (!q) return projects;
    return projects.filter(function(p) {
        return p.name.toLowerCase().includes(q) ||
            (p.custom_name && p.custom_name.toLowerCase().includes(q)) ||
            (p.tags && p.tags.some(function(t) { return t.toLowerCase().includes(q); }));
    });
}

function changeProjectSort(mode) {
    projectSort = mode;
    try { localStorage.setItem('clicodelog-project-sort', mode); } catch (e) { /* ignore */ }
    renderProjects(filteredProjects());
}

(function restoreProjectSort() {
    try {
        var s = localStorage.getItem('clicodelog-project-sort');
        if (s === 'name' || s === 'recent' || s === 'sessions') {
            projectSort = s;
            var sel = document.getElementById('project-sort');
            if (sel) sel.value = s;
        }
    } catch (e) { /* ignore */ }
})();

function projectDisplayName(p) {
    if (p.custom_name) return p.custom_name;
    var parts = String(p.name || '').replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : (p.name || p.id);
}

function renderProjects(projectsList) {
    var container = document.getElementById('projects-list');
    var filtered = activeTagFilter
        ? projectsList.filter(function(p) { return p.tags && p.tags.includes(activeTagFilter); })
        : projectsList.slice();

    filtered.sort(function(a, b) {
        if (projectSort === 'recent') {
            return (Date.parse(b.last_modified) || 0) - (Date.parse(a.last_modified) || 0);
        }
        if (projectSort === 'sessions') return (b.session_count || 0) - (a.session_count || 0);
        return projectDisplayName(a).localeCompare(projectDisplayName(b));
    });

    container.textContent = '';
    if (filtered.length === 0) { container.appendChild(emptyState('', 'No projects found')); return; }
    var frag = document.createDocumentFragment();
    filtered.forEach(function(project) { frag.appendChild(buildProjectItem(project)); });
    container.appendChild(frag);
}

function buildProjectItem(project) {
    var item = document.createElement('div');
    item.className = 'list-item project-item' + (project.id === currentProjectId ? ' active' : '');
    item.dataset.projectId = project.id;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.onclick = function() { selectProject(project.id); };
    item.onkeydown = function(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectProject(project.id); } };

    var ic = document.createElement('span');
    ic.className = 'item-icon';
    ic.appendChild(icon('folder'));

    var body = document.createElement('div');
    body.className = 'item-body';
    var title = document.createElement('div');
    title.className = 'list-item-title';
    title.textContent = projectDisplayName(project);
    title.title = project.cwd || project.name;
    var meta = document.createElement('div');
    meta.className = 'list-item-meta';
    meta.textContent = project.session_count.toLocaleString() +
        (project.session_count === 1 ? ' session' : ' sessions') +
        (project.last_modified ? ' · ' + relativeTime(project.last_modified) : '');
    body.append(title, meta);
    if (project.tags && project.tags.length) {
        var tags = document.createElement('div');
        tags.className = 'item-tags';
        project.tags.forEach(function(t) {
            var chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.style.setProperty('--tag', tagColor(t));
            chip.textContent = t;
            tags.appendChild(chip);
        });
        body.appendChild(tags);
    }

    var editBtn = document.createElement('button');
    editBtn.className = 'icon-btn sm edit-btn';
    editBtn.title = 'Rename or tag this project';
    editBtn.setAttribute('aria-label', 'Rename or tag this project');
    editBtn.appendChild(icon('edit'));
    editBtn.onclick = function(e) { e.stopPropagation(); openEditProject(project.id); };

    item.append(ic, body, editBtn);
    return item;
}

async function openEditProject(projectId) {
    var project = projects.find(function(p) { return p.id === projectId; });
    if (!project) return;
    var newName = prompt('Custom project name (leave empty to use default):', project.custom_name || '');
    if (newName === null) return;
    var newTagsStr = prompt('Tags (comma-separated):', (project.tags || []).join(', '));
    if (newTagsStr === null) return;
    var newTags = newTagsStr.split(',').map(function(t) { return t.trim(); }).filter(Boolean);
    try {
        var r = await fetch('/api/projects/' + encodeURIComponent(projectId) + '/meta?source=' + encodeURIComponent(currentSource), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ custom_name: newName, tags: newTags }),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        await loadProjects();
        await loadTagFilters();
        toast('Project updated');
    } catch (e) {
        toast('Could not save project details');
    }
}

// Moving the highlight used to re-render the whole project list.
function markActiveProject(projectId) {
    var container = document.getElementById('projects-list');
    if (!container) return;
    container.querySelectorAll('.list-item.active').forEach(function(el) { el.classList.remove('active'); });
    var next = container.querySelector('.list-item[data-project-id="' + CSS.escape(projectId) + '"]');
    if (next) {
        next.classList.add('active');
        next.scrollIntoView({ block: 'nearest' });   // e.g. opened from a link
    }
}

// Narrow windows show the project list as a drawer.
function toggleNav(open) {
    document.body.classList.toggle('nav-open', typeof open === 'boolean' ? open : undefined);
}

async function selectProject(projectId, opts) {
    opts = opts || {};
    document.body.classList.remove('nav-open');
    currentProjectId = projectId;
    if (!opts.keepSession) {
        currentSessionId = null;
        resetConversationPane();
    }
    markActiveProject(projectId);
    if (!suppressRouting && !opts.keepSession && typeof pushRoute === 'function') pushRoute();

    setPanel('sessions-list', loadingSpinner('Loading sessions…'));

    var seq = ++projectRequestSeq;
    try {
        var r = await fetch('/api/projects/' + encodeURIComponent(projectId) +
            '/sessions?source=' + encodeURIComponent(currentSource) +
            '&limit=' + SESSION_PAGE);
        if (seq !== projectRequestSeq) return;      // a newer project was clicked
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var data = await r.json();
        if (seq !== projectRequestSeq) return;
        // Older builds returned a bare array; accept both shapes.
        var list = Array.isArray(data) ? data : data.sessions;
        if (!Array.isArray(list)) throw new Error('bad payload');
        currentSessions = list;
        sessionTotal = Array.isArray(data) ? list.length : (data.total || list.length);
        var filters = document.getElementById('session-filters');
        if (filters) filters.hidden = false;
        applySessionFilters();
        // The header may have rendered before the listing arrived.
        if (currentConversation && currentSessionId) renderConvHead(currentConversation);
    } catch (e) {
        if (seq !== projectRequestSeq) return;
        setPanel('sessions-list', errorState('Could not load sessions.', function() {
            selectProject(projectId, opts);
        }));
    }
}

// Fetch the rest of a large project's sessions on demand. Loading all 10,581
// up front cost ~21 MB of server RAM and a 7 MB response for a list nobody
// scrolls to the end of.
async function loadMoreSessions() {
    if (currentSessions.length >= sessionTotal) return;
    var btn = document.getElementById('load-more-sessions');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    var seq = projectRequestSeq;
    try {
        var r = await fetch('/api/projects/' + encodeURIComponent(currentProjectId) +
            '/sessions?source=' + encodeURIComponent(currentSource) +
            '&limit=' + SESSION_PAGE + '&offset=' + currentSessions.length);
        if (seq !== projectRequestSeq) return;
        var data = await r.json();
        var list = Array.isArray(data) ? data : data.sessions;
        if (Array.isArray(list) && list.length) {
            currentSessions = currentSessions.concat(list);
            applySessionFilters();
        }
    } catch (e) { /* the button is restored below */ }
    if (btn) { btn.disabled = false; }
}
