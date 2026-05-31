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
    // With a filter active, the user expects to see every matching message,
    // not just matches within the lazy-loaded window. Load the rest first.
    if (activeFilters.size > 0 && currentConversation &&
        typeof getActiveMessages === 'function' &&
        lazyOffset < getActiveMessages().length) {
        loadAllMessages();
    } else {
        applyRoleFilter();
    }
}

function getScrollEl() {
    var el = document.getElementById('conversation-content');
    if (el) {
        var oy = window.getComputedStyle(el).overflowY;
        if (oy === 'auto' || oy === 'scroll') return el;
    }
    return document.scrollingElement || document.documentElement;
}

function scrollConvToTop() {
    var el = getScrollEl();
    el.scrollTo({ top: 0, behavior: 'smooth' });
}

function scrollConvToBottom() {
    var el = getScrollEl();
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
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

function renderMarkdownInto(el, text) {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
        el.textContent = text;
        return;
    }
    var html = marked.parse(text, { gfm: true, breaks: true, mangle: false, headerIds: false });
    el.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    if (typeof hljs !== 'undefined') {
        el.querySelectorAll('pre code').forEach(function(block) {
            try { hljs.highlightElement(block); } catch (e) {}
        });
    }
}

function getActiveMessages() {
    if (!currentConversation) return [];
    var msgs = currentConversation.messages;
    if (dateFromFilter == null && dateToFilter == null) return msgs;
    return msgs.filter(function(m) {
        if (!m.timestamp) return false;
        var t = Date.parse(m.timestamp);
        if (isNaN(t)) return false;
        if (dateFromFilter != null && t < dateFromFilter) return false;
        if (dateToFilter != null && t > dateToFilter) return false;
        return true;
    });
}

function updateFilterStatus() {
    var el = document.getElementById('conv-filter-status');
    if (!el || !currentConversation) return;
    var total = currentConversation.messages.length;
    var shown = getActiveMessages().length;
    el.textContent = (dateFromFilter || dateToFilter) ? (shown + ' / ' + total + ' in range') : '';
}

function showFilterLoading(on) {
    var el = document.getElementById('conv-filter-loading');
    if (el) el.style.display = on ? 'inline-flex' : 'none';
    var btn = document.getElementById('apply-filter-btn');
    if (btn) btn.disabled = !!on;
}

function applyDateFilter() {
    var fromEl = document.getElementById('date-from');
    var toEl = document.getElementById('date-to');
    if (fromEl && fromEl.value) {
        var d = new Date(fromEl.value + 'T00:00:00');
        dateFromFilter = isNaN(d) ? null : d.getTime();
    } else { dateFromFilter = null; }
    if (toEl && toEl.value) {
        var d2 = new Date(toEl.value + 'T23:59:59.999');
        dateToFilter = isNaN(d2) ? null : d2.getTime();
    } else { dateToFilter = null; }
    showFilterLoading(true);
    // Defer to next frame so the spinner can paint before the heavy re-render
    // blocks the main thread.
    requestAnimationFrame(function() {
        setTimeout(function() {
            try { rerenderCurrentConversation(); }
            finally { showFilterLoading(false); }
        }, 0);
    });
}

function clearDateFilter() {
    var fromEl = document.getElementById('date-from');
    var toEl = document.getElementById('date-to');
    if (fromEl) fromEl.value = '';
    if (toEl) toEl.value = '';
    dateFromFilter = null;
    dateToFilter = null;
    rerenderCurrentConversation();
}

function rerenderCurrentConversation() {
    if (!currentConversation) return;
    var messagesDiv = document.getElementById('messages-container');
    var sentinel = document.getElementById('lazy-sentinel');
    if (!messagesDiv || !sentinel) return;
    if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
    messagesDiv.textContent = '';
    lazyOffset = 0;
    renderNextBatch(messagesDiv);
    var msgs = getActiveMessages();
    var remaining = msgs.length - lazyOffset;
    sentinel.style.display = remaining > 0 ? '' : 'none';
    sentinel.textContent = remaining > 0 ? (remaining + ' more…') : '';
    requestAnimationFrame(function() { setupLazyObserver(messagesDiv); });
    updateFilterStatus();
}

function loadAllMessages(onComplete) {
    if (!currentConversation) { if (onComplete) onComplete(); return; }
    var messagesDiv = document.getElementById('messages-container');
    if (!messagesDiv) { if (onComplete) onComplete(); return; }
    var msgs = getActiveMessages();
    var loadAllBtn = document.getElementById('load-all-btn');

    // Already fully rendered — just run the callback (or scroll to bottom).
    if (lazyOffset >= msgs.length) {
        if (onComplete) onComplete();
        else requestAnimationFrame(scrollConvToBottom);
        return;
    }

    if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
    var sentinel = document.getElementById('lazy-sentinel');
    if (loadAllBtn) loadAllBtn.disabled = true;

    var CHUNK = 50;

    function renderChunk() {
        var end = Math.min(lazyOffset + CHUNK, msgs.length);
        for (var i = lazyOffset; i < end; i++) {
            messagesDiv.appendChild(buildMessageEl(msgs[i]));
        }
        lazyOffset = end;
        if (sentinel) {
            var remaining = msgs.length - lazyOffset;
            sentinel.textContent = remaining > 0
                ? ('Loading… ' + lazyOffset + ' / ' + msgs.length)
                : '';
            sentinel.style.display = remaining > 0 ? '' : 'none';
        }
        if (lazyOffset < msgs.length) {
            // setTimeout(0) yields back to the browser so it can paint
            // progress and remain responsive between chunks.
            setTimeout(renderChunk, 0);
        } else {
            applyRoleFilter();
            if (loadAllBtn) loadAllBtn.disabled = false;
            if (onComplete) {
                onComplete();
            } else {
                // scrollIntoView is reliable with content-visibility because
                // the browser lays out and scrolls to the actual element.
                requestAnimationFrame(function() {
                    requestAnimationFrame(function() {
                        var last = messagesDiv.lastElementChild;
                        if (last && last.scrollIntoView) {
                            last.scrollIntoView({ block: 'end', behavior: 'auto' });
                        } else {
                            var el = getScrollEl();
                            el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
                        }
                    });
                });
            }
        }
    }
    renderChunk();
}

// --- In-conversation find: searches the whole conversation, loading every
// --- message first so matches outside the lazy window are still found.
function runConvSearch() {
    var input = document.getElementById('conv-search-input');
    convSearchQuery = (input ? input.value : '').trim().toLowerCase();
    if (!convSearchQuery) { clearConvSearch(); return; }
    var status = document.getElementById('conv-search-status');
    if (status) status.textContent = 'Searching…';
    loadAllMessages(function() { applyConvSearch(); });
}

function applyConvSearch() {
    convSearchMatches = [];
    convSearchIndex = -1;
    var mc = document.getElementById('messages-container');
    if (!mc) return;
    mc.querySelectorAll('.message').forEach(function(el) {
        el.classList.remove('search-match', 'search-current');
        if (convSearchQuery && el.textContent.toLowerCase().indexOf(convSearchQuery) !== -1) {
            el.classList.add('search-match');
            convSearchMatches.push(el);
        }
    });
    updateConvSearchStatus();
    if (convSearchMatches.length) gotoConvMatch(0);
}

function gotoConvMatch(i) {
    if (!convSearchMatches.length) return;
    if (convSearchIndex >= 0 && convSearchMatches[convSearchIndex]) {
        convSearchMatches[convSearchIndex].classList.remove('search-current');
    }
    convSearchIndex = (i % convSearchMatches.length + convSearchMatches.length) % convSearchMatches.length;
    var el = convSearchMatches[convSearchIndex];
    el.classList.add('search-current');
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    updateConvSearchStatus();
}

function convSearchNext() {
    if (!convSearchMatches.length) { runConvSearch(); return; }
    gotoConvMatch(convSearchIndex + 1);
}

function convSearchPrev() {
    if (!convSearchMatches.length) { runConvSearch(); return; }
    gotoConvMatch(convSearchIndex - 1);
}

function updateConvSearchStatus() {
    var el = document.getElementById('conv-search-status');
    if (!el) return;
    if (!convSearchQuery) { el.textContent = ''; return; }
    el.textContent = convSearchMatches.length
        ? (convSearchIndex + 1) + ' / ' + convSearchMatches.length + ' matches'
        : 'No matches';
}

function clearConvSearch() {
    convSearchQuery = '';
    convSearchMatches = [];
    convSearchIndex = -1;
    var input = document.getElementById('conv-search-input');
    if (input) input.value = '';
    var mc = document.getElementById('messages-container');
    if (mc) mc.querySelectorAll('.message').forEach(function(el) {
        el.classList.remove('search-match', 'search-current');
    });
    updateConvSearchStatus();
}

function openFocusView() {
    if (!currentProjectId || !currentSessionId) return;
    var url = '/view?source=' + encodeURIComponent(currentSource) +
              '&project=' + encodeURIComponent(currentProjectId) +
              '&session=' + encodeURIComponent(currentSessionId);
    window.open(url, '_blank', 'noopener');
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
        content.className = 'message-content markdown';
        renderMarkdownInto(content, msg.content);
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
    var msgs = getActiveMessages();
    var end = Math.min(lazyOffset + lazyBatchSize, msgs.length);
    for (var i = lazyOffset; i < end; i++) {
        messagesDiv.appendChild(buildMessageEl(msgs[i]));
    }
    lazyOffset = end;
    applyRoleFilter();
}

function setupLazyObserver(messagesDiv) {
    if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
    if (!currentConversation || lazyOffset >= getActiveMessages().length) return;
    var sentinel = document.getElementById('lazy-sentinel');
    if (!sentinel) return;
    var scrollRoot = document.getElementById('conversation-content');
    if (scrollRoot) {
        var oy = window.getComputedStyle(scrollRoot).overflowY;
        if (oy !== 'auto' && oy !== 'scroll') scrollRoot = null;
    }
    lazyObserver = new IntersectionObserver(function(entries) {
        if (!entries[0].isIntersecting) return;
        renderNextBatch(messagesDiv);
        var remaining = getActiveMessages().length - lazyOffset;
        if (remaining <= 0) {
            lazyObserver.disconnect(); lazyObserver = null;
            sentinel.style.display = 'none';
        } else {
            sentinel.textContent = remaining + ' more\u2026';
        }
    }, { root: scrollRoot, rootMargin: '600px' });
    lazyObserver.observe(sentinel);
}

function renderConversation(conv) {
    // Strip empty user protocol messages (tool-result acknowledgments with no content)
    conv.messages = conv.messages.filter(function(m) {
        return !(m.role === 'user' && !m.content && !(m.tool_uses && m.tool_uses.length > 0));
    });
    currentConversation = conv;
    lazyOffset = 0;
    if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }

    activeFilters.clear();
    dateFromFilter = null;
    dateToFilter = null;
    convSearchQuery = '';
    convSearchMatches = [];
    convSearchIndex = -1;
    var dfFrom = document.getElementById('date-from');
    var dfTo = document.getElementById('date-to');
    var dfSearch = document.getElementById('conv-search-input');
    var dfSearchStatus = document.getElementById('conv-search-status');
    if (dfFrom) dfFrom.value = '';
    if (dfTo) dfTo.value = '';
    if (dfSearch) dfSearch.value = '';
    if (dfSearchStatus) dfSearchStatus.textContent = '';
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
    var remaining = getActiveMessages().length - lazyOffset;
    if (remaining > 0) sentinel.textContent = remaining + ' more\u2026';
    container.appendChild(sentinel);

    requestAnimationFrame(function() { setupLazyObserver(messagesDiv); });
    updateFilterStatus();

    var exportBtn = document.getElementById('export-btn');
    var copyBtn = document.getElementById('copy-btn');
    if (exportBtn) exportBtn.disabled = false;
    if (copyBtn) copyBtn.disabled = false;
}
