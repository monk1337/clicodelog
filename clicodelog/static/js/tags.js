var TAG_COLORS = ['#e53e3e','#dd6b20','#d69e2e','#38a169','#319795','#3182ce','#5a67d8','#805ad5','#d53f8c','#718096'];

function tagColor(tag) {
    var hash = 0;
    for (var i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
    return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

async function loadTagFilters() {
    try {
        const tags = await fetch('/api/tags?source=' + currentSource).then(r => r.json());
        const bar = document.getElementById('tag-filter-bar');
        if (tags.length === 0) {
            bar.classList.remove('visible');
            bar.textContent = '';
            activeTagFilter = null;
            return;
        }
        bar.classList.add('visible');
        bar.textContent = '';
        const label = document.createElement('span');
        label.className = 'tag-filter-label';
        label.textContent = 'Tags:';
        bar.appendChild(label);
        tags.forEach(function(t) {
            const chip = document.createElement('span');
            chip.className = 'tag-filter-chip' + (activeTagFilter === t ? ' active' : '');
            chip.style.background = tagColor(t);
            chip.textContent = t;
            chip.onclick = function() { filterByTag(t); };
            bar.appendChild(chip);
        });
    } catch (e) {
        console.error('Error loading tags:', e);
    }
}

function filterByTag(tag) {
    activeTagFilter = activeTagFilter === tag ? null : tag;
    renderProjects(projects);
    loadTagFilters();
}
