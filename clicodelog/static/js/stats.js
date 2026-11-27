// Usage analytics and the full-text index controls.
// Token figures here include cache reads and cache writes; the UI previously
// counted only input+output and reported about 0.9% of real usage.

var statsGroup = 'day';

function toggleStats(force) {
    var modal = document.getElementById('stats-modal');
    if (!modal) return;
    var active = typeof force === 'boolean' ? force : !modal.classList.contains('active');
    modal.classList.toggle('active', active);
    if (active) { closeMenus(); loadStats(); }
}

(function wireStatsScrim() {
    var modal = document.getElementById('stats-modal');
    if (modal) modal.addEventListener('mousedown', function(e) { if (e.target === modal) toggleStats(false); });
})();

async function loadStats() {
    var body = document.getElementById('stats-body');
    if (!body) return;
    setPanel('stats-body', loadingSpinner('Crunching…'));
    try {
        var r = await fetch('/api/stats?source=' + encodeURIComponent(currentSource) +
            '&group=' + encodeURIComponent(statsGroup));
        if (!r.ok) throw new Error('HTTP ' + r.status);
        renderStats(await r.json());
    } catch (e) {
        setPanel('stats-body', errorState('Could not load stats.', loadStats));
    }
}

function setStatsGroup(g) {
    statsGroup = g;
    document.querySelectorAll('.stats-tab').forEach(function(b) {
        b.classList.toggle('active', b.dataset.group === g);
        b.setAttribute('aria-selected', b.dataset.group === g ? 'true' : 'false');
    });
    loadStats();
}

function renderStats(data) {
    var body = document.getElementById('stats-body');
    body.textContent = '';

    var summary = document.createElement('div');
    summary.className = 'stats-summary';
    [
        ['Sessions', (data.sessions || 0).toLocaleString()],
        ['Total tokens', formatTokens(data.total_tokens || 0)],
        ['Cache reads', formatTokens((data.totals || {}).cache_read || 0)],
        ['Output', formatTokens((data.totals || {}).output || 0)],
    ].forEach(function(pair) {
        var tile = document.createElement('div');
        tile.className = 'stat-tile';
        var n = document.createElement('div');
        n.className = 'stat-n';
        n.textContent = pair[1];
        var l = document.createElement('div');
        l.className = 'stat-l';
        l.textContent = pair[0];
        tile.appendChild(n);
        tile.appendChild(l);
        summary.appendChild(tile);
    });
    body.appendChild(summary);

    var rows = data.rows || [];
    if (!rows.length) {
        body.appendChild(noResults('No usage recorded yet.'));
        return;
    }

    var max = rows.reduce(function(m, r) {
        return Math.max(m, r.total_tokens || r.count || 0);
    }, 0) || 1;

    var list = document.createElement('div');
    list.className = 'stats-rows';
    rows.slice(0, 60).forEach(function(row) {
        var value = row.total_tokens != null ? row.total_tokens : row.count;

        var line = document.createElement('div');
        line.className = 'stats-row';

        var label = document.createElement('span');
        label.className = 'stats-label';
        label.textContent = row.key;
        label.title = row.key;

        var barWrap = document.createElement('span');
        barWrap.className = 'stats-bar';
        var bar = document.createElement('span');
        bar.style.width = Math.max(1, (value / max) * 100) + '%';
        barWrap.appendChild(bar);

        var val = document.createElement('span');
        val.className = 'stats-value';
        val.textContent = row.total_tokens != null
            ? formatTokens(value) + (row.sessions ? '  ·  ' + row.sessions + ' sess' : '')
            : value.toLocaleString();

        line.appendChild(label);
        line.appendChild(barWrap);
        line.appendChild(val);
        list.appendChild(line);
    });
    body.appendChild(list);
}

// --- full-text index ------------------------------------------------------
async function pollSearchIndexStatus() {
    var el = document.getElementById('index-status');
    if (!el) return;
    try {
        var r = await fetch('/api/search/status?source=' + encodeURIComponent(currentSource));
        if (!r.ok) return;
        var s = await r.json();
        renderIndexStatus(s);
        if (s.state === 'building') setTimeout(pollSearchIndexStatus, 2000);
    } catch (e) { /* status is advisory */ }
}

function renderIndexStatus(s) {
    var el = document.getElementById('index-status');
    if (!el) return;
    el.textContent = '';

    if (s.state === 'ready') {
        el.textContent = 'Full-text search ready · ' +
            (s.messages || 0).toLocaleString() + ' messages indexed';
        return;
    }
    if (s.state === 'building') {
        el.textContent = 'Indexing ' + (s.done || 0) + ' / ' + (s.total || 0) + ' sessions…';
        return;
    }
    if (s.state === 'blocked') {
        el.textContent = s.reason || 'Index build blocked.';
        return;
    }
    if (s.state === 'unavailable') {
        el.textContent = 'Full-text search unavailable: ' + (s.reason || '');
        return;
    }

    // not_built — offer it, with an honest size estimate up front.
    var gb = (s.needed_bytes || 0) / 1e9;
    var freeMb = (s.free_bytes || 0) / 1e6;
    el.appendChild(document.createTextNode(
        'Content search is off. Building the index needs about ' +
        gb.toFixed(2) + ' GB (' + freeMb.toFixed(0) + ' MB free). '));

    var btn = document.createElement('button');
    btn.className = 'btn btn-tonal sm';
    btn.textContent = s.fits ? 'Build index' : 'Build anyway';
    btn.onclick = function() { buildSearchIndex(!s.fits); };
    el.appendChild(btn);

    if (!s.fits) {
        var lite = document.createElement('button');
        lite.className = 'btn btn-text sm';
        lite.textContent = 'Build without tool output (smaller)';
        lite.onclick = function() { buildSearchIndex(true, 0); };
        el.appendChild(lite);
    }
}

async function buildSearchIndex(force, toolCap) {
    var url = '/api/search/build?source=' + encodeURIComponent(currentSource);
    if (force) url += '&force=true';
    if (toolCap != null) url += '&tool_cap=' + toolCap;
    try {
        await fetch(url, { method: 'POST' });
        setTimeout(pollSearchIndexStatus, 500);
    } catch (e) { /* the status poll will surface any failure */ }
}
