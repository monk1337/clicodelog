// Bookmarks panel: grouped by project, then by conversation, and searchable.
//
// The flat list of every bookmark stopped being browsable once there were a
// hundred of them across dozens of projects. Each project is now a collapsible
// folder holding its conversations, each conversation holds its bookmarks in
// the order they occur, and the search box narrows all of it at once.

var bmQuery = '';
var bmRole = 'all';               // 'all' | 'user' | 'assistant'
var bmCollapsed = {};             // group key -> true when folded
var BM_COLLAPSE_KEY = 'clicodelog-bm-collapsed';

try { bmCollapsed = JSON.parse(localStorage.getItem(BM_COLLAPSE_KEY) || '{}') || {}; }
catch (e) { bmCollapsed = {}; }

// Folded unless the user has said otherwise; projects other than the one on
// screen start folded so a long list opens as a tidy index of folders.
function bmIsCollapsed(key, byDefault) {
    return Object.prototype.hasOwnProperty.call(bmCollapsed, key) ? !!bmCollapsed[key] : !!byDefault;
}

function saveBmCollapsed() {
    try { localStorage.setItem(BM_COLLAPSE_KEY, JSON.stringify(bmCollapsed)); } catch (e) { /* ignore */ }
}

function shortProjectName(full) {
    var parts = String(full || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (!parts.length) return full || 'Unknown project';
    return parts.slice(-2).join('/');
}

// Previews are stored as raw message text, so markdown syntax (**bold**,
// ## headings, `code`) showed up literally. Strip just the markers; underscores
// are left alone because they live inside identifiers.
function cleanPreview(text) {
    return String(text || '')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*|`+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function bmTimeLabel(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleString([], { year: '2-digit', month: 'short', day: 'numeric',
                                  hour: '2-digit', minute: '2-digit' });
}

function bmMatches(b, terms) {
    if (bmRole !== 'all' && b.role !== bmRole) return false;
    if (!terms.length) return true;
    var hay = [cleanPreview(b.preview), b.preview, b.project_name, b.session_summary, b.role, b.session_id]
        .join(' ').toLowerCase();
    return terms.every(function(t) { return hay.indexOf(t) !== -1; });
}

// Text with every search term wrapped in <mark>, built without innerHTML.
function highlightInto(el, text, terms) {
    text = String(text || '');
    if (!terms.length) { el.textContent = text; return; }
    var lower = text.toLowerCase();
    var i = 0;
    while (i < text.length) {
        var best = -1, len = 0;
        terms.forEach(function(t) {
            var at = lower.indexOf(t, i);
            if (at !== -1 && (best === -1 || at < best)) { best = at; len = t.length; }
        });
        if (best === -1) { el.appendChild(document.createTextNode(text.slice(i))); break; }
        if (best > i) el.appendChild(document.createTextNode(text.slice(i, best)));
        var m = document.createElement('mark');
        m.textContent = text.slice(best, best + len);
        el.appendChild(m);
        i = best + len;
    }
}

// project -> conversation -> bookmarks, each level ordered by most recent use.
function groupBookmarks(list) {
    var projects = {};
    list.forEach(function(b) {
        var pk = (b.source || '') + '|' + (b.project_id || '');
        var p = projects[pk] || (projects[pk] = {
            key: pk, name: b.project_name || b.project_id || 'Unknown project',
            source: b.source, sessions: {}, count: 0, latest: '',
        });
        var s = p.sessions[b.session_id] || (p.sessions[b.session_id] = {
            key: pk + '|' + b.session_id, id: b.session_id,
            title: b.session_summary || '', items: [], latest: '',
        });
        s.items.push(b);
        p.count++;
        var c = b.created || '';
        if (c > s.latest) s.latest = c;
        if (c > p.latest) p.latest = c;
    });
    return Object.keys(projects).map(function(k) {
        var p = projects[k];
        p.sessionList = Object.keys(p.sessions).map(function(id) {
            var s = p.sessions[id];
            // Inside a conversation, read in the order things happened.
            s.items.sort(function(a, b) { return (a.timestamp || '').localeCompare(b.timestamp || ''); });
            return s;
        }).sort(function(a, b) { return b.latest.localeCompare(a.latest); });
        return p;
    }).sort(function(a, b) { return b.latest.localeCompare(a.latest); });
}

function buildBmToolbar(total, shown) {
    var bar = document.createElement('div');
    bar.className = 'bm-toolbar';

    var input = document.createElement('input');
    input.type = 'search';
    input.id = 'bm-search';
    input.className = 'bm-search';
    input.placeholder = 'Search bookmarks, projects, conversations…';
    input.value = bmQuery;
    input.oninput = function() {
        bmQuery = input.value;
        renderBookmarksPanel(true);
    };
    bar.appendChild(input);

    var row = document.createElement('div');
    row.className = 'bm-toolbar-row';
    [['all', 'All'], ['user', 'User'], ['assistant', 'AI']].forEach(function(pair) {
        var chip = document.createElement('button');
        chip.className = 'bm-chip' + (bmRole === pair[0] ? ' active' : '');
        chip.textContent = pair[1];
        chip.onclick = function() { bmRole = pair[0]; renderBookmarksPanel(); };
        row.appendChild(chip);
    });

    var spacer = document.createElement('span');
    spacer.className = 'bm-count';
    spacer.textContent = shown === total ? total + ' saved' : shown + ' of ' + total;
    row.appendChild(spacer);

    [['Expand all', false], ['Collapse all', true]].forEach(function(pair) {
        var b = document.createElement('button');
        b.className = 'bm-link';
        b.textContent = pair[0];
        b.onclick = function() {
            groupBookmarks(allBookmarks).forEach(function(p) {
                bmCollapsed[p.key] = pair[1];
                p.sessionList.forEach(function(s) { bmCollapsed[s.key] = pair[1]; });
            });
            saveBmCollapsed();
            renderBookmarksPanel();
        };
        row.appendChild(b);
    });
    bar.appendChild(row);
    return bar;
}

function buildBmItem(b, terms) {
    var item = document.createElement('div');
    item.className = 'bookmark-item';
    item.title = 'Open this message';

    var meta = document.createElement('div');
    meta.className = 'bookmark-meta';
    var role = document.createElement('span');
    role.className = 'bm-role bm-role-' + (b.role || 'other');
    role.textContent = b.role === 'assistant' ? 'AI' : (b.role || '?');
    meta.appendChild(role);
    meta.appendChild(document.createTextNode(' ' + bmTimeLabel(b.timestamp)));
    item.appendChild(meta);

    var prev = document.createElement('div');
    prev.className = 'bookmark-preview';
    highlightInto(prev, cleanPreview(b.preview) || '(no preview)', terms);
    item.appendChild(prev);

    item.onclick = function() { gotoBookmark(b); };

    var del = document.createElement('button');
    del.className = 'bookmark-del';
    del.textContent = '✕';
    del.title = 'Remove bookmark';
    del.onclick = function(e) {
        e.stopPropagation();
        fetch('/api/bookmarks/' + encodeURIComponent(b.id), { method: 'DELETE' })
            .then(function(r) { return r.json(); })
            .then(function(l) { allBookmarks = l || []; refreshBookmarkSet(); renderBookmarksPanel(); });
    };
    item.appendChild(del);
    return item;
}

function buildBmGroupHeader(cls, label, sub, count, key, open) {
    var h = document.createElement('div');
    h.className = cls;
    var caret = document.createElement('span');
    caret.className = 'bm-caret';
    caret.textContent = open ? '▾' : '▸';
    h.appendChild(caret);

    var text = document.createElement('span');
    text.className = 'bm-group-label';
    text.textContent = label;
    if (sub) text.title = sub;
    h.appendChild(text);

    var n = document.createElement('span');
    n.className = 'bm-group-count';
    n.textContent = count;
    h.appendChild(n);

    h.onclick = function() {
        bmCollapsed[key] = open;          // open now -> fold it, and vice versa
        saveBmCollapsed();
        renderBookmarksPanel();
    };
    return h;
}

function renderBookmarksPanel(keepFocus) {
    var list = document.getElementById('bookmarks-list');
    if (!list) return;
    list.textContent = '';

    var terms = bmQuery.toLowerCase().split(/\s+/).filter(Boolean);
    var filtered = allBookmarks.filter(function(b) { return bmMatches(b, terms); });
    var searching = terms.length > 0 || bmRole !== 'all';

    list.appendChild(buildBmToolbar(allBookmarks.length, filtered.length));
    if (keepFocus) {
        var input = document.getElementById('bm-search');
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }

    if (!allBookmarks.length) {
        var empty = document.createElement('div');
        empty.className = 'bookmarks-empty';
        empty.textContent = 'No bookmarks yet. Click ☆ on any message to pin it.';
        list.appendChild(empty);
        return;
    }
    if (!filtered.length) {
        var none = document.createElement('div');
        none.className = 'bookmarks-empty';
        none.textContent = 'No bookmarks match.';
        list.appendChild(none);
        return;
    }

    // Bookmarks in the conversation on screen come first, unfolded.
    var here = filtered.filter(function(b) {
        return b.session_id === currentSessionId && b.source === currentSource;
    });
    if (here.length) {
        var hereBox = document.createElement('div');
        hereBox.className = 'bm-project bm-here';
        var hereOpen = searching || !bmIsCollapsed('here', false);
        hereBox.appendChild(buildBmGroupHeader('bm-project-header', '📌 This conversation',
            '', here.length, 'here', hereOpen));
        if (hereOpen) {
            here.slice().sort(function(a, b) { return (a.timestamp || '').localeCompare(b.timestamp || ''); })
                .forEach(function(b) { hereBox.appendChild(buildBmItem(b, terms)); });
        }
        list.appendChild(hereBox);
    }

    groupBookmarks(filtered).forEach(function(p) {
        var box = document.createElement('div');
        box.className = 'bm-project';
        // Searching unfolds whatever matches, so results are never hidden.
        var isCurrent = p.source === currentSource && p.key === currentSource + '|' + currentProjectId;
        var pOpen = searching || !bmIsCollapsed(p.key, !isCurrent);
        box.appendChild(buildBmGroupHeader('bm-project-header', '📁 ' + shortProjectName(p.name),
            p.name, p.count, p.key, pOpen));
        if (pOpen) {
            p.sessionList.forEach(function(s) {
                var sBox = document.createElement('div');
                sBox.className = 'bm-session';
                var title = s.title || ('Session ' + (s.id || '').slice(0, 8));
                var sOpen = searching || !bmIsCollapsed(s.key, false);
                sBox.appendChild(buildBmGroupHeader('bm-session-header', title,
                    title + ' · ' + s.id, s.items.length, s.key, sOpen));
                if (sOpen) {
                    s.items.forEach(function(b) { sBox.appendChild(buildBmItem(b, terms)); });
                }
                box.appendChild(sBox);
            });
        }
        list.appendChild(box);
    });
}
