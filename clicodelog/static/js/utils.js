// Small shared helpers: formatting, panel states, icons, toasts, menus.

function formatTime(timestamp) {
    if (!timestamp) return '';
    return new Date(timestamp).toLocaleString();
}

function formatSize(bytes) {
    bytes = bytes || 0;
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// "just now", "5 min ago", "Yesterday", "Mon", "Mar 4", "Mar 4, 2024".
function relativeTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var now = new Date();
    var secs = (now - d) / 1000;
    if (secs < 60) return 'just now';
    if (secs < 3600) return Math.floor(secs / 60) + ' min ago';
    var startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (d >= startOfToday) return Math.floor(secs / 3600) + ' h ago';
    var days = Math.floor((startOfToday - d) / 86400000) + 1;
    if (days === 1) return 'Yesterday';
    if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
    if (d.getFullYear() === now.getFullYear()) {
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }
    return d.toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

var SVG_NS = 'http://www.w3.org/2000/svg';

// An icon from the sprite in templates/_icons.html.
function icon(name, cls) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'i' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
}

function setPanel(id, node) {
    var el = document.getElementById(id);
    if (!el) return;
    el.textContent = '';
    el.appendChild(node);
}

function emptyState(iconName, text, heading) {
    var div = document.createElement('div');
    div.className = 'empty-state';
    if (iconName && /^[a-z-]+$/.test(iconName)) {
        var i = document.createElement('div');
        i.className = 'empty-state-icon';
        i.appendChild(icon(iconName));
        div.appendChild(i);
    }
    if (heading) {
        var h = document.createElement('h3');
        h.textContent = heading;
        div.appendChild(h);
    }
    var p = document.createElement('p');
    p.textContent = text;
    div.appendChild(p);
    return div;
}

function noResults(text) {
    var div = document.createElement('div');
    div.className = 'no-search-results';
    div.textContent = text;
    return div;
}

function loadingSpinner(label) {
    var div = document.createElement('div');
    div.className = 'loading';
    div.setAttribute('role', 'status');
    var spinner = document.createElement('div');
    spinner.className = 'spinner';
    div.appendChild(spinner);
    div.appendChild(document.createTextNode(label || 'Loading…'));
    return div;
}

// A failure the user can act on, instead of a pane that silently stays stale.
function errorState(message, onRetry) {
    var div = document.createElement('div');
    div.className = 'empty-state error-state';
    var p = document.createElement('p');
    p.textContent = message;
    div.appendChild(p);
    if (typeof onRetry === 'function') {
        var btn = document.createElement('button');
        btn.className = 'btn btn-tonal retry-btn';
        btn.textContent = 'Try again';
        btn.onclick = onRetry;
        div.appendChild(btn);
    }
    return div;
}

async function copyToClipboard(text, btn, doneLabel) {
    try {
        await navigator.clipboard.writeText(text);
        if (btn) {
            btn.classList.add('copied');
            setTimeout(function() { btn.classList.remove('copied'); }, 1800);
        }
        if (doneLabel) toast(doneLabel);
        return true;
    } catch (e) {
        return false;
    }
}

// One snackbar, reused. Announced politely to screen readers.
var toastTimer = null;
function toast(text) {
    var el = document.getElementById('toast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'toast';
        el.className = 'toast';
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { el.classList.remove('show'); }, 2600);
}

// Popover menus: one open at a time; outside click and Escape close them.
function toggleMenu(id) {
    var menu = document.getElementById(id);
    if (!menu) return;
    var open = !menu.classList.contains('open');
    closeMenus();
    if (open) {
        menu.classList.add('open');
        var trigger = menu.parentElement && menu.parentElement.querySelector('[aria-haspopup]');
        if (trigger) trigger.setAttribute('aria-expanded', 'true');
    }
}

function closeMenus() {
    document.querySelectorAll('.menu.open').forEach(function(m) {
        m.classList.remove('open');
        var trigger = m.parentElement && m.parentElement.querySelector('[aria-haspopup]');
        if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
}

document.addEventListener('click', function(e) {
    if (!e.target.closest || !e.target.closest('.menu-wrap')) closeMenus();
});

function isTyping(e) {
    var t = e.target;
    return !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
}
