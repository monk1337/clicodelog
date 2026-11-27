// Project tags: a stable colour per tag, and the filter chips above the list.
var TAG_COLORS = ['#d93025', '#e8710a', '#f9ab00', '#188038', '#12b5cb', '#1a73e8', '#7b61ff', '#a142f4', '#e52592', '#5f6368'];

function tagColor(tag) {
    var hash = 0;
    for (var i = 0; i < tag.length; i++) hash = ((hash << 5) - hash + tag.charCodeAt(i)) | 0;
    return TAG_COLORS[Math.abs(hash) % TAG_COLORS.length];
}

async function loadTagFilters() {
    var bar = document.getElementById('tag-filter-bar');
    if (!bar) return;
    try {
        var tags = await fetch('/api/tags?source=' + encodeURIComponent(currentSource)).then(function(r) { return r.json(); });
        bar.textContent = '';
        if (!tags.length) {
            bar.hidden = true;
            activeTagFilter = null;
            return;
        }
        bar.hidden = false;
        tags.forEach(function(t) {
            var chip = document.createElement('button');
            chip.className = 'chip tag-filter-chip' + (activeTagFilter === t ? ' active' : '');
            chip.style.setProperty('--tag', tagColor(t));
            var dot = document.createElement('span');
            dot.className = 'tag-dot';
            chip.append(dot, document.createTextNode(t));
            chip.onclick = function() { filterByTag(t); };
            bar.appendChild(chip);
        });
    } catch (e) {
        console.error('Error loading tags:', e);
    }
}

function filterByTag(tag) {
    activeTagFilter = activeTagFilter === tag ? null : tag;
    renderProjects(filteredProjects());
    loadTagFilters();
}
