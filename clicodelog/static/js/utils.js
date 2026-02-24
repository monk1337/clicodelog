function formatTime(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString();
}

function formatSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function setPanel(id, node) {
    const el = document.getElementById(id);
    el.textContent = '';
    el.appendChild(node);
}

function emptyState(icon, text, heading) {
    const div = document.createElement('div');
    div.className = 'empty-state';
    if (icon) {
        const i = document.createElement('div');
        i.className = 'empty-state-icon';
        i.textContent = icon;
        div.appendChild(i);
    }
    if (heading) {
        const h = document.createElement('h3');
        h.textContent = heading;
        div.appendChild(h);
    }
    const p = document.createElement('p');
    p.textContent = text;
    div.appendChild(p);
    return div;
}

function noResults(text) {
    const div = document.createElement('div');
    div.className = 'no-search-results';
    div.textContent = text;
    return div;
}

function loadingSpinner(label) {
    const div = document.createElement('div');
    div.className = 'loading';
    const spinner = document.createElement('div');
    spinner.className = 'spinner';
    div.appendChild(spinner);
    div.appendChild(document.createTextNode(label));
    return div;
}
