// The conversation header: title, facts about the session, and its actions
// (resume, open in editor, copy, export, focus view).

function buildSummaries(list) {
    var d = mkEl('details', 'conv-summaries');
    var s = mkEl('summary', '', list.length === 1 ? '1 summary' : list.length + ' summaries');
    d.appendChild(s);
    list.forEach(function(t) { d.appendChild(mkEl('p', 'summary-tag', t)); });
    return d;
}

function sessionListing() {
    return (currentSessions || []).find(function(x) { return x.id === currentSessionId; }) || null;
}

function sessionTitle(conv) {
    var info = conv.info || {};
    var s = sessionListing();
    var t = info.summary || (s && s.summary) || '';
    if (t && t !== 'No summary') return t;
    return 'Session ' + String(currentSessionId || '').slice(0, 8);
}

function dateRangeLabel(a, b) {
    var da = a ? new Date(a) : null, db = b ? new Date(b) : null;
    if (da && isNaN(da)) da = null;
    if (db && isNaN(db)) db = null;
    if (!da && !db) return '';
    var opt = { month: 'short', day: 'numeric' };
    var last = db || da;
    var fa = da ? da.toLocaleDateString([], opt) : '';
    var fb = db ? db.toLocaleDateString([], opt) : '';
    var year = last.getFullYear();
    if (!fa || fa === fb || !fb) return (fb || fa) + ', ' + year;
    var ya = da.getFullYear();
    return fa + (ya !== year ? ', ' + ya : '') + ' – ' + fb + ', ' + year;
}

function latestBranch(conv) {
    for (var k = conv.messages.length - 1; k >= 0; k--) {
        if (conv.messages[k].gitBranch) return conv.messages[k].gitBranch;
    }
    return '';
}

function metaItem(iconName, text, title) {
    var s = mkEl('span', 'conv-meta-item');
    if (iconName) s.appendChild(icon(iconName));
    s.appendChild(document.createTextNode(text));
    if (title) s.title = title;
    return s;
}

function convCwd(conv) {
    return (conv && conv.meta && conv.meta.cwd) || (conv && conv.info && conv.info.cwd) || sessionCwd();
}

function renderConvHead(conv) {
    var head = document.getElementById('conv-head');
    if (!head) return;
    head.textContent = '';
    var info = conv.info || {};
    var listing = sessionListing() || {};

    var title = mkEl('h1', 'conv-title', sessionTitle(conv));
    title.title = title.textContent;
    head.appendChild(title);
    var viewTitle = document.getElementById('view-title');
    if (viewTitle) { viewTitle.textContent = title.textContent; document.title = title.textContent + ' · clicodelog'; }

    var row = mkEl('div', 'conv-meta');
    var cwd = convCwd(conv);
    if (cwd) row.appendChild(metaItem('folder', shortPath(cwd), cwd));
    var branch = latestBranch(conv);
    if (branch) row.appendChild(metaItem('', '⎇ ' + branch));
    var total = conv.total_messages != null ? conv.total_messages : conv.messages.length;
    row.appendChild(metaItem('chat', total.toLocaleString() + ' messages'));
    var usage = indexedSessionUsage();
    var tok = usage ? totalTokens(usage) : 0;
    if (tok) row.appendChild(metaItem('bolt', formatTokens(tok) + ' tokens', tokenBreakdown(usage)));
    var range = dateRangeLabel(info.first_ts || listing.first_timestamp, info.last_ts || listing.last_timestamp);
    if (range) row.appendChild(metaItem('calendar', range));
    head.appendChild(row);

    head.appendChild(buildSessionActions(conv));
}

function actionButton(cls, iconName, label, title, onclick) {
    var b = mkEl('button', cls);
    if (iconName) b.appendChild(icon(iconName));
    if (label) b.appendChild(mkEl('span', 'label', label));
    if (title) { b.title = title; if (!label) b.setAttribute('aria-label', title); }
    b.onclick = onclick;
    return b;
}

function buildSessionActions(conv) {
    var row = mkEl('div', 'conv-actions');
    var cmd = resumeCommand(conv);
    if (cmd) {
        row.appendChild(actionButton('btn btn-tonal', 'terminal', 'Resume', 'Copy: ' + cmd, function() {
            copyToClipboard(cmd).then(function(ok) { toast(ok ? 'Resume command copied' : 'Could not copy'); });
        }));
    }
    var cwd = convCwd(conv);
    if (cwd) {
        var editor = 'code';
        try { editor = localStorage.getItem('clicodelog-editor') || 'code'; } catch (e) { /* ignore */ }
        var openCmd = editor + ' ' + shellQuote(cwd);
        row.appendChild(actionButton('btn btn-text', 'code', 'Open in editor', 'Copy: ' + openCmd, function() {
            copyToClipboard(openCmd).then(function(ok) { toast(ok ? 'Editor command copied' : 'Could not copy'); });
        }));
    }
    row.appendChild(mkEl('span', 'grow'));

    var copyBtn = actionButton('icon-btn', 'copy', '', 'Copy conversation', copyConversation);
    copyBtn.id = 'copy-btn';
    row.appendChild(copyBtn);

    var wrap = mkEl('div', 'menu-wrap');
    var exp = actionButton('btn btn-outlined', 'download', 'Export', 'Export this conversation',
        function(e) { e.stopPropagation(); toggleMenu('export-menu'); });
    exp.setAttribute('aria-haspopup', 'menu');
    var menu = mkEl('div', 'menu menu-right');
    menu.id = 'export-menu';
    menu.setAttribute('role', 'menu');
    [['export-btn', 'Readable text (.txt)', exportConversation],
     ['export-md-btn', 'Markdown (.md)', exportMarkdown],
     ['export-raw-btn', 'Raw log (.jsonl)', exportRawConversation]].forEach(function(spec) {
        var item = actionButton('menu-item', '', spec[1], '', function() { closeMenus(); spec[2](); });
        item.id = spec[0];
        item.setAttribute('role', 'menuitem');
        menu.appendChild(item);
    });
    wrap.append(exp, menu);
    row.appendChild(wrap);

    if (!document.body.classList.contains('focus-page')) {
        var focus = actionButton('icon-btn', 'open', '', 'Open in a focused tab', openFocusView);
        focus.id = 'fullscreen-btn';
        row.appendChild(focus);
    }
    return row;
}

function resumeCommand(conv) {
    if (!currentSessionId) return null;
    var cwd = convCwd(conv);
    var prefix = cwd ? 'cd ' + shellQuote(cwd) + ' && ' : '';
    if (currentSource === 'claude-code') return prefix + 'claude --resume ' + currentSessionId;
    if (currentSource === 'codex') return prefix + 'codex resume ' + currentSessionId;
    return null;   // Gemini CLI has no id-based resume
}

function sessionCwd() {
    var s = sessionListing();
    if (s && s.cwd) return s.cwd;
    var p = (projects || []).find(function(x) { return x.id === currentProjectId; });
    return (p && p.cwd) || '';
}

function shellQuote(s) {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}
