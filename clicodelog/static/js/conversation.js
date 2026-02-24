function applyRoleFilter() {
    var mc = document.getElementById('messages-container');
    if (!mc) return;
    var empty = activeFilters.size === 0;
    mc.querySelectorAll('.message').forEach(function(el) {
        if (empty) { el.style.display = ''; return; }
        var show = (activeFilters.has('user') && el.classList.contains('user')) ||
                   (activeFilters.has('assistant') && el.classList.contains('assistant')) ||
                   (activeFilters.has('tools') && el.classList.contains('has-tools'));
        el.style.display = show ? '' : 'none';
    });
}

function toggleRoleFilter(filter) {
    if (activeFilters.has(filter)) { activeFilters.delete(filter); }
    else { activeFilters.add(filter); }
    document.querySelectorAll('.role-btn').forEach(function(btn) {
        btn.classList.toggle('active', activeFilters.has(btn.getAttribute('data-filter')));
    });
    applyRoleFilter();
}

function scrollConvToTop() {
    var el = document.getElementById('conversation-content');
    if (el) el.scrollTo({ top: 0, behavior: 'smooth' });
}

function scrollConvToBottom() {
    var el = document.getElementById('conversation-content');
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}

function shortPath(cwd) {
    if (!cwd) return '';
    var parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    return '~/' + (parts[parts.length - 1] || '');
}

function formatTokens(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n);
}

function toggleAllThinking() {
    allThinkingExpanded = !allThinkingExpanded;
    var btn = document.getElementById('thinking-toggle-btn');
    document.querySelectorAll('.thinking-block').forEach(function(b) {
        b.classList.toggle('expanded', allThinkingExpanded);
    });
    btn.classList.toggle('active', allThinkingExpanded);
    btn.querySelector('span:last-child').textContent = allThinkingExpanded ? 'Hide Thinking' : 'Show Thinking';
}

function buildMessageEl(msg) {
    var classes = 'message ' + msg.role;
    if (msg.tool_uses && msg.tool_uses.length > 0) classes += ' has-tools';
    if (msg.thinking) classes += ' has-thinking';
    var msgDiv = document.createElement('div');
    msgDiv.className = classes;

    var msgHeader = document.createElement('div');
    msgHeader.className = 'message-header';

    var roleSpan = document.createElement('span');
    roleSpan.className = 'message-role';
    roleSpan.textContent = msg.role;
    msgHeader.appendChild(roleSpan);

    if (msg.model) {
        var badge = document.createElement('span');
        badge.className = 'model-badge';
        badge.textContent = msg.model;
        msgHeader.appendChild(badge);
    }

    var timeSpan = document.createElement('span');
    timeSpan.className = 'message-time';
    timeSpan.textContent = formatTime(msg.timestamp);
    msgHeader.appendChild(timeSpan);

    if (msg.role === 'user') {
        if (msg.cwd) {
            var cwdChip = document.createElement('span');
            cwdChip.className = 'msg-chip';
            cwdChip.textContent = shortPath(msg.cwd);
            msgHeader.appendChild(cwdChip);
        }
        if (msg.gitBranch) {
            var branchChip = document.createElement('span');
            branchChip.className = 'msg-chip msg-branch';
            branchChip.textContent = '\u2387 ' + msg.gitBranch;
            msgHeader.appendChild(branchChip);
        }
    }

    if (msg.usage) {
        var usage = document.createElement('span');
        usage.className = 'usage-info';
        var toks = (msg.usage.input_tokens || 0) + (msg.usage.output_tokens || 0);
        usage.textContent = formatTokens(toks) + ' tok';
        msgHeader.appendChild(usage);
    }
    msgDiv.appendChild(msgHeader);

    if (msg.content && msg.content.trim()) {
        var content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = msg.content;
        msgDiv.appendChild(content);
    }

    if (msg.thinking) {
        var block = document.createElement('div');
        block.className = 'thinking-block' + (allThinkingExpanded ? ' expanded' : '');
        block.onclick = function() { block.classList.toggle('expanded'); };
        var thinkHeader = document.createElement('div');
        thinkHeader.className = 'thinking-header';
        thinkHeader.textContent = 'Thinking';
        var thinkContent = document.createElement('div');
        thinkContent.className = 'thinking-content';
        thinkContent.textContent = msg.thinking;
        block.appendChild(thinkHeader);
        block.appendChild(thinkContent);
        msgDiv.appendChild(block);
    }

    if (msg.tool_uses && msg.tool_uses.length > 0) {
        var toolsDiv = document.createElement('div');
        toolsDiv.className = 'tool-uses';
        msg.tool_uses.forEach(function(tool) {
            var toolDiv = document.createElement('div');
            toolDiv.className = 'tool-use';
            var toolName = document.createElement('div');
            toolName.className = 'tool-name';
            toolName.textContent = tool.name;
            var toolInput = document.createElement('div');
            toolInput.className = 'tool-input';
            toolInput.textContent = typeof tool.input === 'string' ? tool.input : JSON.stringify(tool.input, null, 2);
            toolDiv.appendChild(toolName);
            toolDiv.appendChild(toolInput);
            toolsDiv.appendChild(toolDiv);
        });
        msgDiv.appendChild(toolsDiv);
    }

    return msgDiv;
}

function renderNextBatch(messagesDiv) {
    if (!currentConversation) return;
    var msgs = currentConversation.messages;
    var end = Math.min(lazyOffset + lazyBatchSize, msgs.length);
    for (var i = lazyOffset; i < end; i++) {
        messagesDiv.appendChild(buildMessageEl(msgs[i]));
    }
    lazyOffset = end;
    applyRoleFilter();
}

function setupLazyObserver(messagesDiv) {
    if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
    if (!currentConversation || lazyOffset >= currentConversation.messages.length) return;
    var sentinel = document.getElementById('lazy-sentinel');
    if (!sentinel) return;
    lazyObserver = new IntersectionObserver(function(entries) {
        if (!entries[0].isIntersecting) return;
        renderNextBatch(messagesDiv);
        var remaining = currentConversation.messages.length - lazyOffset;
        if (remaining <= 0) {
            lazyObserver.disconnect(); lazyObserver = null;
            sentinel.style.display = 'none';
        } else {
            sentinel.textContent = remaining + ' more\u2026';
        }
    }, { root: document.getElementById('conversation-content'), rootMargin: '300px' });
    lazyObserver.observe(sentinel);
}

function renderConversation(conv) {
    // Strip empty user protocol messages (tool-result acknowledgments with no content)
    conv.messages = conv.messages.filter(function(m) {
        return !(m.role === 'user' && !m.content && !(m.tool_uses && m.tool_uses.length > 0));
    });
    currentConversation = conv;
    lazyOffset = 0;
    roleFilter = 'all';
    if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }

    activeFilters.clear();
    var filterBar = document.getElementById('conv-filter-bar');
    if (filterBar) {
        filterBar.style.display = 'flex';
        document.querySelectorAll('.role-btn').forEach(function(btn) {
            btn.classList.remove('active');
        });
    }

    var container = document.getElementById('conversation-content');
    container.textContent = '';

    var totalTokens = conv.messages.reduce(function(acc, m) {
        if (!m.usage) return acc;
        return acc + (m.usage.input_tokens || 0) + (m.usage.output_tokens || 0);
    }, 0);

    var header = document.createElement('div');
    header.className = 'conversation-header';
    var h1 = document.createElement('h1');
    h1.textContent = 'Session: ' + conv.session_id;
    var metaRow = document.createElement('div');
    metaRow.className = 'conversation-meta';
    var countSpan = document.createElement('span');
    countSpan.textContent = conv.messages.length + ' messages';
    metaRow.appendChild(countSpan);
    if (totalTokens > 0) {
        var tokSpan = document.createElement('span');
        tokSpan.className = 'total-tokens';
        tokSpan.textContent = formatTokens(totalTokens) + ' tokens';
        metaRow.appendChild(tokSpan);
    }
    header.appendChild(h1);
    header.appendChild(metaRow);
    container.appendChild(header);

    if (conv.summaries && conv.summaries.length > 0) {
        var summDiv = document.createElement('div');
        summDiv.className = 'summaries';
        var strong = document.createElement('strong');
        strong.textContent = 'Summaries:';
        summDiv.appendChild(strong);
        summDiv.appendChild(document.createElement('br'));
        conv.summaries.forEach(function(s) {
            var tag = document.createElement('span');
            tag.className = 'summary-tag';
            tag.textContent = s;
            summDiv.appendChild(tag);
        });
        container.appendChild(summDiv);
    }

    var messagesDiv = document.createElement('div');
    messagesDiv.className = 'messages';
    messagesDiv.id = 'messages-container';
    renderNextBatch(messagesDiv);
    container.appendChild(messagesDiv);

    var sentinel = document.createElement('div');
    sentinel.id = 'lazy-sentinel';
    sentinel.className = 'lazy-sentinel';
    var remaining = conv.messages.length - lazyOffset;
    if (remaining > 0) sentinel.textContent = remaining + ' more\u2026';
    container.appendChild(sentinel);

    requestAnimationFrame(function() { setupLazyObserver(messagesDiv); });

    document.getElementById('export-btn').disabled = false;
    document.getElementById('copy-btn').disabled = false;
}
