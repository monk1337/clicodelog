// One class on the container instead of an inline style written to every one of
// potentially thousands of message nodes on each filter change and batch append.
function applyRoleFilter() {
    var mc = document.getElementById('messages-container');
    if (!mc) return;
    var empty = activeFilters.size === 0;
    mc.classList.toggle('filtering', !empty);
    mc.classList.toggle('show-user', activeFilters.has('user'));
    mc.classList.toggle('show-assistant', activeFilters.has('assistant'));
    mc.classList.toggle('show-tools', activeFilters.has('tools'));
}

// The session's own working directory makes the CLI reachable again: after
// finding an old session the next thing you want is to continue it.
function resumeCommand(conv) {
    var cwd = (conv && conv.meta && conv.meta.cwd) || sessionCwd();
    var id = currentSessionId;
    if (!id) return null;
    if (currentSource === 'claude-code') {
        return (cwd ? 'cd ' + shellQuote(cwd) + ' && ' : '') + 'claude --resume ' + id;
    }
    if (currentSource === 'codex') {
        return (cwd ? 'cd ' + shellQuote(cwd) + ' && ' : '') + 'codex resume ' + id;
    }
    return null;   // Gemini CLI has no id-based resume
}

function sessionCwd() {
    var s = (currentSessions || []).find(function(x) { return x.id === currentSessionId; });
    if (s && s.cwd) return s.cwd;
    var p = (projects || []).find(function(x) { return x.id === currentProjectId; });
    return (p && p.cwd) || '';
}

function shellQuote(s) {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : "'" + s.replace(/'/g, "'\\''") + "'";
}

function buildSessionActions(conv) {
    var row = document.createElement('div');
    row.className = 'session-actions';

    var cmd = resumeCommand(conv);
    if (cmd) {
        var resume = document.createElement('button');
        resume.className = 'action-chip';
        resume.textContent = 'Copy resume command';
        resume.title = cmd;
        resume.onclick = function() { copyToClipboard(cmd, resume, 'Copied'); };
        row.appendChild(resume);
    }

    var cwd = (conv && conv.meta && conv.meta.cwd) || sessionCwd();
    if (cwd) {
        var open = document.createElement('button');
        open.className = 'action-chip';
        open.textContent = 'Copy editor command';
        var editor = localStorage.getItem('clicodelog-editor') || 'code';
        var openCmd = editor + ' ' + shellQuote(cwd);
        open.title = openCmd;
        open.onclick = function() { copyToClipboard(openCmd, open, 'Copied'); };
        row.appendChild(open);

        var path = document.createElement('span');
        path.className = 'session-cwd';
        path.textContent = cwd;
        row.appendChild(path);
    }
    return row;
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
    // Sessions here reach tens of billions of tokens once cache reads are
    // counted, and capping the scale at M rendered that as "30269.4M".
    if (n >= 1e12) return (n / 1e12).toFixed(1) + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
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
    // Highlighting is deferred until a block is actually on screen. Running
    // hljs eagerly on every block — with language auto-detection, its most
    // expensive path — was minutes of jank on a large session.
    el.querySelectorAll('pre code').forEach(observeForHighlight);
}

var MAX_HIGHLIGHT_BYTES = 50000;

function observeForHighlight(block) {
    if (typeof hljs === 'undefined') return;
    if (block.textContent.length > MAX_HIGHLIGHT_BYTES) return;   // not worth it
    if (!highlightObserver) {
        if (!('IntersectionObserver' in window)) { highlightBlock(block); return; }
        highlightObserver = new IntersectionObserver(function(entries) {
            entries.forEach(function(entry) {
                if (!entry.isIntersecting) return;
                highlightObserver.unobserve(entry.target);
                highlightBlock(entry.target);
            });
        }, { rootMargin: '400px' });
    }
    highlightObserver.observe(block);
}

function highlightBlock(block) {
    if (block.dataset.highlighted) return;
    block.dataset.highlighted = '1';
    try {
        // Passing the fenced language avoids auto-detection across every grammar.
        var cls = (block.className || '').match(/language-([\w-]+)/);
        if (cls && hljs.getLanguage(cls[1])) {
            block.innerHTML = hljs.highlight(block.textContent, { language: cls[1] }).value;
        } else {
            hljs.highlightElement(block);
        }
    } catch (e) { /* highlighting is cosmetic; never break rendering */ }
}

// Chronological (oldest → newest), after date filtering. Used by export so
// exports stay in natural order regardless of display direction.
function getChronologicalMessages() {
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

// Display order — what the conversation pane renders. Honors the newest/oldest
// toggle. Default: newest first (reversed).
function getActiveMessages() {
    var msgs = getChronologicalMessages();
    if (msgOrder === 'newest') return msgs.slice().reverse();
    return msgs;
}

function setMsgOrderLabel() {
    var btn = document.getElementById('msg-order-btn');
    if (btn) {
        var label = btn.querySelector('span:last-child') || btn;
        label.textContent = (msgOrder === 'newest') ? 'Newest first' : 'Oldest first';
    }
}

function toggleMsgOrder() {
    msgOrder = (msgOrder === 'newest') ? 'oldest' : 'newest';
    setMsgOrderLabel();
    // Only part of a long session is loaded, and the loaded window is now at
    // the wrong end of it — reversing what we already have would show the
    // wrong messages. Refetch from the correct end.
    if (currentConversation && hasMoreOnServer()) {
        reloadConversationWindow();
        return;
    }
    rerenderCurrentConversation();
}

// Refetch the window at whichever end the current order needs.
async function reloadConversationWindow() {
    if (!currentProjectId || !currentSessionId) return;
    var seq = ++sessionRequestSeq;
    var container = document.getElementById('conversation-content');
    if (container) setPanel('conversation-content', loadingSpinner('Loading…'));
    try {
        var url = '/api/projects/' + encodeURIComponent(currentProjectId) +
            '/sessions/' + encodeURIComponent(currentSessionId) +
            '?source=' + encodeURIComponent(currentSource) +
            '&limit=' + CONV_PAGE +
            (msgOrder === 'newest' ? '&tail=true' : '&offset=0');
        var r = await fetch(url);
        if (seq !== sessionRequestSeq) return;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var conv = await r.json();
        if (seq !== sessionRequestSeq) return;
        if (!conv || conv.error || !Array.isArray(conv.messages)) throw new Error('bad payload');
        cachePut(cacheKeyFor(currentSource, currentProjectId, currentSessionId), conv);
        renderConversation(conv);
    } catch (e) {
        if (seq !== sessionRequestSeq) return;
        setPanel('conversation-content',
            errorState('Could not reload this conversation.', reloadConversationWindow));
    }
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
    requestAnimationFrame(function() {
        setupLazyObserver(messagesDiv);
        setupTopObserver(messagesDiv);
    });
    updateFilterStatus();
}

// Pull every page the server still holds, so "Load All" means the whole
// session again — not merely everything already downloaded.
async function fetchWholeSession(onProgress) {
    if (!currentConversation || currentConversation.total_messages == null) return;
    var guard = 0;
    while ((hasOlderOnServer() || hasNewerOnServer()) && guard < 5000) {
        guard++;
        var back = hasOlderOnServer();
        var nextOffset = back ? Math.max(0, convWindowStart - LOAD_ALL_PAGE) : convWindowEnd;
        var wanted = back
            ? convWindowStart - nextOffset
            : Math.min(LOAD_ALL_PAGE, currentConversation.total_messages - convWindowEnd);
        if (wanted <= 0) break;

        var seq = sessionRequestSeq;
        var url = '/api/projects/' + encodeURIComponent(currentProjectId) +
            '/sessions/' + encodeURIComponent(currentSessionId) +
            '?source=' + encodeURIComponent(currentSource) +
            '&limit=' + wanted + '&offset=' + nextOffset;
        var r = await fetch(url);
        if (seq !== sessionRequestSeq) return;          // user moved on
        if (!r.ok) break;
        var page = await r.json();
        if (seq !== sessionRequestSeq) return;
        if (!page || !Array.isArray(page.messages) || !page.messages.length) break;

        var rawLen = page.messages.length;
        var clean = stripProtocolMessages(page.messages);
        if (back) {
            currentConversation.messages = clean.concat(currentConversation.messages);
            convWindowStart = page.offset;
        } else {
            currentConversation.messages = currentConversation.messages.concat(clean);
            convWindowEnd = page.offset + rawLen;
        }
        currentConversation.total_messages = page.total_messages;
        if (onProgress) {
            onProgress(convWindowEnd - convWindowStart, currentConversation.total_messages);
        }
    }
}

// Render every message already in memory. No fetching — used by the anchored
// jump, which deliberately holds only a small window.
function renderLoadedMessages(onComplete) {
    var messagesDiv = document.getElementById('messages-container');
    if (!messagesDiv || !currentConversation) { if (onComplete) onComplete(); return; }
    var msgs = getActiveMessages();
    var sentinel = document.getElementById('lazy-sentinel');

    function chunk() {
        var end = Math.min(lazyOffset + 100, msgs.length);
        for (var i = lazyOffset; i < end; i++) {
            messagesDiv.appendChild(buildMessageEl(msgs[i], i));
        }
        lazyOffset = end;
        if (lazyOffset < msgs.length) {
            setTimeout(chunk, 0);
        } else {
            applyRoleFilter();
            if (sentinel) {
                var more = hasMoreOnServer();
                sentinel.style.display = more ? '' : 'none';
                sentinel.textContent = more ? 'Load more…' : '';
            }
            if (onComplete) onComplete();
        }
    }
    chunk();
}

async function loadAllMessages(onComplete) {
    if (!currentConversation) { if (onComplete) onComplete(); return; }
    var messagesDiv = document.getElementById('messages-container');
    if (!messagesDiv) { if (onComplete) onComplete(); return; }

    var loadAllBtn = document.getElementById('load-all-btn');
    var sentinel = document.getElementById('lazy-sentinel');
    if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
    if (loadAllBtn) loadAllBtn.disabled = true;

    // Step 1: make sure the whole session is actually in memory.
    if (hasMoreOnServer()) {
        if (sentinel) {
            sentinel.style.display = '';
            sentinel.textContent = 'Fetching all ' +
                currentConversation.total_messages.toLocaleString() + ' messages…';
        }
        try {
            await fetchWholeSession(function(have, total) {
                if (sentinel) {
                    sentinel.textContent = 'Fetching ' + have.toLocaleString() +
                        ' / ' + total.toLocaleString() + '…';
                }
            });
        } catch (e) { /* fall through and render what we have */ }
    }

    // Step 2: render everything, yielding between chunks so the tab stays alive.
    var msgs = getActiveMessages();
    if (lazyOffset >= msgs.length) {
        if (loadAllBtn) loadAllBtn.disabled = false;
        markConversationComplete();
        if (onComplete) onComplete();
        else requestAnimationFrame(scrollConvToBottom);
        return;
    }

    var CHUNK = 100;

    function renderChunk() {
        var end = Math.min(lazyOffset + CHUNK, msgs.length);
        for (var i = lazyOffset; i < end; i++) {
            messagesDiv.appendChild(buildMessageEl(msgs[i], i));
        }
        lazyOffset = end;
        if (sentinel) {
            var remaining = msgs.length - lazyOffset;
            sentinel.textContent = remaining > 0
                ? ('Rendering… ' + lazyOffset.toLocaleString() + ' / ' + msgs.length.toLocaleString())
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
            markConversationComplete();
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

// Open a session centred on one message — how a bookmark or a search hit gets
// there instantly instead of rendering everything before it first.
async function openAtAnchor(uuid, opts) {
    opts = opts || {};
    if (!uuid || !currentProjectId || !currentSessionId) return false;
    var seq = ++sessionRequestSeq;
    setPanel('conversation-content', loadingSpinner('Jumping to bookmark…'));
    try {
        var url = '/api/projects/' + encodeURIComponent(currentProjectId) +
            '/sessions/' + encodeURIComponent(currentSessionId) +
            '?source=' + encodeURIComponent(currentSource) +
            '&limit=' + ANCHOR_WINDOW +
            '&around_uuid=' + encodeURIComponent(uuid);
        var r = await fetch(url);
        if (seq !== sessionRequestSeq) return false;
        if (!r.ok) throw new Error('HTTP ' + r.status);
        var conv = await r.json();
        if (seq !== sessionRequestSeq) return false;
        if (!conv || conv.error || !Array.isArray(conv.messages)) throw new Error('bad payload');

        cachePut(cacheKeyFor(currentSource, currentProjectId, currentSessionId), conv);
        renderConversation(conv);

        // Render just this window — pulling the whole session here would undo
        // the point of jumping straight to the message.
        renderLoadedMessages(function() {
            requestAnimationFrame(function() {
                requestAnimationFrame(function() {
                    scrollToAnchor(uuid, true);
                    // Both edges start filling in as soon as the short window
                    // is on screen. Re-assert the position a couple of times so
                    // the bookmarked message stays put while they land.
                    setTimeout(function() { scrollToAnchor(uuid, true); }, 400);
                    setTimeout(function() { scrollToAnchor(uuid, true); }, 1200);
                });
            });
        });
        return true;
    } catch (e) {
        if (seq !== sessionRequestSeq) return false;
        setPanel('conversation-content',
            errorState('Could not jump to that message.', function() { openAtAnchor(uuid, opts); }));
        return false;
    }
}

// --- In-conversation find: searches the whole conversation, loading every
// --- message first so matches outside the lazy window are still found.
// Searching the model, not the DOM: matches are found without rendering
// anything, so a find no longer forces a full materialisation of every message.
function messageText(msg) {
    var parts = [];
    if (msg.content) parts.push(msg.content);
    if (msg.thinking) parts.push(msg.thinking);
    (msg.tool_uses || []).forEach(function(t) {
        if (t.name) parts.push(t.name);
        if (t.input) {
            parts.push(typeof t.input === 'object' ? JSON.stringify(t.input) : String(t.input));
        }
    });
    return parts.join('\n').toLowerCase();
}

function runConvSearch() {
    var input = document.getElementById('conv-search-input');
    convSearchQuery = (input ? input.value : '').trim().toLowerCase();
    if (!convSearchQuery) { clearConvSearch(); return; }

    var msgs = getActiveMessages();
    convSearchMatches = [];
    for (var i = 0; i < msgs.length; i++) {
        if (messageText(msgs[i]).indexOf(convSearchQuery) !== -1) convSearchMatches.push(i);
    }
    convSearchIndex = -1;
    updateConvSearchStatus();

    if (!convSearchMatches.length) { markRenderedMatches(); return; }
    // Render only as far as the first match instead of the whole conversation.
    ensureRendered(convSearchMatches[0], function() {
        markRenderedMatches();
        gotoConvMatch(0);
    });
}

// Render forward until index `target` exists in the DOM.
function ensureRendered(target, done) {
    var messagesDiv = document.getElementById('messages-container');
    if (!messagesDiv) { if (done) done(); return; }
    if (lazyOffset > target) { if (done) done(); return; }
    var msgs = getActiveMessages();
    function step() {
        var end = Math.min(lazyOffset + 50, msgs.length);
        for (var i = lazyOffset; i < end; i++) {
            messagesDiv.appendChild(buildMessageEl(msgs[i], i));
        }
        lazyOffset = end;
        if (lazyOffset <= target && lazyOffset < msgs.length) setTimeout(step, 0);
        else {
            applyRoleFilter();
            var sentinel = document.getElementById('lazy-sentinel');
            if (sentinel) {
                var remaining = msgs.length - lazyOffset;
                sentinel.style.display = remaining > 0 ? '' : 'none';
                sentinel.textContent = remaining > 0 ? (remaining + ' more…') : '';
            }
            if (done) done();
        }
    }
    step();
}

function markRenderedMatches() {
    var mc = document.getElementById('messages-container');
    if (!mc) return;
    var hits = {};
    convSearchMatches.forEach(function(i) { hits[i] = true; });
    mc.querySelectorAll('.message').forEach(function(el) {
        el.classList.remove('search-match', 'search-current');
        if (hits[Number(el.dataset.index)]) el.classList.add('search-match');
    });
}

function messageElAt(index) {
    var mc = document.getElementById('messages-container');
    return mc ? mc.querySelector('.message[data-index="' + index + '"]') : null;
}

// convSearchMatches holds message indexes now, not DOM nodes, so a match beyond
// the rendered window is still navigable — we render up to it on demand.
function gotoConvMatch(i) {
    if (!convSearchMatches.length) return;
    var prev = messageElAt(convSearchMatches[convSearchIndex]);
    if (prev) prev.classList.remove('search-current');

    convSearchIndex = (i % convSearchMatches.length + convSearchMatches.length) % convSearchMatches.length;
    var target = convSearchMatches[convSearchIndex];

    ensureRendered(target, function() {
        markRenderedMatches();
        var el = messageElAt(target);
        if (el) {
            el.classList.add('search-current');
            el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
        updateConvSearchStatus();
    });
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

// Hide/show the yellow tool boxes (Bash, Read, etc.). When hidden, messages
// that are nothing but a tool box collapse away entirely (CSS), so the
// conversation reads cleanly without the command dumps.
function toggleToolBoxes() {
    var on = document.body.classList.toggle('hide-tool-boxes');
    var btn = document.getElementById('tools-toggle-btn');
    if (btn) {
        btn.classList.toggle('active', on);
        var label = btn.querySelector('span:last-child');
        if (label) label.textContent = on ? 'Show Tools' : 'Hide Tools';
    }
}

function buildMessageEl(msg, msgIndex) {
    var classes = 'message ' + msg.role;
    if (msg.tool_uses && msg.tool_uses.length > 0) classes += ' has-tools';
    if (msg.thinking) classes += ' has-thinking';
    if (msg.content && msg.content.trim()) classes += ' has-text';
    var msgDiv = document.createElement('div');
    msgDiv.className = classes;

    var anchor = bookmarkAnchor(msg, msgIndex);
    msgDiv.setAttribute('data-anchor', anchor);
    msgDiv.dataset.index = String(msgIndex);   // lets find/outline target it

    var msgHeader = document.createElement('div');
    msgHeader.className = 'message-header';

    var roleSpan = document.createElement('span');
    roleSpan.className = 'message-role';
    roleSpan.textContent = msg.role;
    msgHeader.appendChild(roleSpan);

    var pinBtn = document.createElement('button');
    pinBtn.className = 'pin-btn' + (isBookmarked(anchor) ? ' pinned' : '');
    pinBtn.title = 'Pin / bookmark this message';
    pinBtn.textContent = isBookmarked(anchor) ? '★' : '☆';
    pinBtn.onclick = function (e) {
        e.stopPropagation();
        toggleBookmark(msg, msgIndex, anchor, pinBtn);
    };
    msgHeader.appendChild(pinBtn);

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
        // All four fields. Counting only input+output ignored cache reads,
        // which with prompt caching are nearly all of the real usage.
        var toks = totalTokens(msg.usage);
        usage.textContent = formatTokens(toks) + ' tok';
        usage.title = tokenBreakdown(msg.usage);
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
        messagesDiv.appendChild(buildMessageEl(msgs[i], i));
    }
    lazyOffset = end;
    applyRoleFilter();
}

function setupLazyObserver(messagesDiv) {
    if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
    if (!currentConversation) return;
    if (lazyOffset >= getActiveMessages().length) {
        // Everything downloaded is on screen. Either pull the next page, or
        // retire the sentinel — leaving it as-is stranded it on "Loading more…"
        // after the final page had already arrived.
        if (hasMoreOnServer()) fetchNextConversationPage();
        else markConversationComplete();
        return;
    }
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
            // Rendered everything downloaded so far \u2014 pull the next page if the
            // server still has more of this session.
            if (hasMoreOnServer()) {
                sentinel.textContent = 'Loading more\u2026';
                fetchNextConversationPage();
                return;
            }
            lazyObserver.disconnect(); lazyObserver = null;
            sentinel.style.display = 'none';
        } else {
            sentinel.textContent = remaining + ' more\u2026';
        }
    }, { root: scrollRoot, rootMargin: '600px' });
    lazyObserver.observe(sentinel);
}

function hasOlderOnServer() {
    return !!(currentConversation && currentConversation.total_messages != null
              && convWindowStart > 0);
}

function hasNewerOnServer() {
    return !!(currentConversation && currentConversation.total_messages != null
              && convWindowEnd < currentConversation.total_messages);
}

// Either side counts. After jumping to a bookmark the loaded window sits in the
// middle of the session, so scrolling can need messages in either direction.
function hasMoreOnServer() {
    return hasOlderOnServer() || hasNewerOnServer();
}

// Conversations arrive a page at a time so the server never has to parse a
// whole 966 MB session to show the top of it.
// Retire the sentinel once the whole session is loaded, so it never sits on
// "Loading more…" with nothing coming.
function markConversationComplete() {
    var sentinel = document.getElementById('lazy-sentinel');
    if (sentinel) {
        sentinel.style.display = 'none';
        sentinel.textContent = '';
    }
    if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
}

// Load whichever end of the session an edge needs.
//
// getActiveMessages() is reversed when the order is newest-first, so which
// server direction extends the top of the list depends on that order:
//   newest-first  -> top = newer messages, bottom = older
//   oldest-first  -> top = older messages, bottom = newer
async function loadEdge(edge) {
    if (convFetchInFlight || !currentConversation) return;
    if (currentConversation.total_messages == null) return;

    var wantOlder = (edge === 'top') ? (msgOrder !== 'newest') : (msgOrder === 'newest');
    if (wantOlder ? !hasOlderOnServer() : !hasNewerOnServer()) {
        if (edge === 'bottom') markConversationComplete();
        else markTopComplete();
        return;
    }

    convFetchInFlight = true;
    var seq = sessionRequestSeq;
    try {
        var nextOffset, wanted;
        if (wantOlder) {
            nextOffset = Math.max(0, convWindowStart - CONV_PAGE);
            wanted = convWindowStart - nextOffset;
        } else {
            nextOffset = convWindowEnd;
            wanted = Math.min(CONV_PAGE, currentConversation.total_messages - convWindowEnd);
        }
        if (wanted <= 0) return;

        var url = '/api/projects/' + encodeURIComponent(currentProjectId) +
            '/sessions/' + encodeURIComponent(currentSessionId) +
            '?source=' + encodeURIComponent(currentSource) +
            '&limit=' + wanted + '&offset=' + nextOffset;
        var r = await fetch(url);
        if (seq !== sessionRequestSeq) return;
        if (!r.ok) return;
        var page = await r.json();
        if (seq !== sessionRequestSeq) return;
        if (!page || !Array.isArray(page.messages) || !page.messages.length) return;

        var rawLen = page.messages.length;
        var clean = stripProtocolMessages(page.messages);
        if (wantOlder) {
            currentConversation.messages = clean.concat(currentConversation.messages);
            convWindowStart = page.offset;
        } else {
            currentConversation.messages = currentConversation.messages.concat(clean);
            convWindowEnd = page.offset + rawLen;
        }
        currentConversation.total_messages = page.total_messages;

        var messagesDiv = document.getElementById('messages-container');
        if (!messagesDiv) return;

        if (edge === 'top') {
            prependRendered(messagesDiv, clean.length);
        } else {
            renderNextBatch(messagesDiv);
        }
        requestAnimationFrame(function() {
            setupLazyObserver(messagesDiv);
            setupTopObserver(messagesDiv);
        });
        updateFilterStatus();
    } catch (e) {
        // Leave the sentinel in place; scrolling again retries.
    } finally {
        convFetchInFlight = false;
    }
}

// The new messages landed at the FRONT of getActiveMessages(), so every
// already-rendered node shifts down by n. Insert the new nodes above and hold
// the viewport still, otherwise the content the user is reading jumps away.
function prependRendered(messagesDiv, n) {
    if (n <= 0) return;
    var msgs = getActiveMessages();
    var scroller = getScrollEl();
    var heightBefore = scroller.scrollHeight;
    var first = messagesDiv.firstChild;

    var frag = document.createDocumentFragment();
    for (var i = 0; i < n; i++) {
        frag.appendChild(buildMessageEl(msgs[i], i));
    }
    messagesDiv.insertBefore(frag, first);
    lazyOffset += n;
    applyRoleFilter();

    var delta = scroller.scrollHeight - heightBefore;
    if (delta) scroller.scrollTop += delta;
}

// Kept for callers that just want "more, in the reading direction".
function fetchNextConversationPage() {
    return loadEdge('bottom');
}

function markTopComplete() {
    var s = document.getElementById('lazy-sentinel-top');
    if (s) { s.style.display = 'none'; s.textContent = ''; }
    if (topObserver) { topObserver.disconnect(); topObserver = null; }
}

function setupTopObserver(messagesDiv) {
    if (topObserver) { topObserver.disconnect(); topObserver = null; }
    var sentinel = document.getElementById('lazy-sentinel-top');
    if (!sentinel || !currentConversation) return;

    var wantOlder = msgOrder !== 'newest';
    var more = wantOlder ? hasOlderOnServer() : hasNewerOnServer();
    if (!more) { markTopComplete(); return; }

    sentinel.style.display = '';
    sentinel.textContent = wantOlder ? 'Earlier messages…' : 'Newer messages…';

    var scrollRoot = document.getElementById('conversation-content');
    if (scrollRoot) {
        var oy = window.getComputedStyle(scrollRoot).overflowY;
        if (oy !== 'auto' && oy !== 'scroll') scrollRoot = null;
    }
    topObserver = new IntersectionObserver(function(entries) {
        if (!entries[0].isIntersecting) return;
        loadEdge('top');
    }, { root: scrollRoot, rootMargin: '600px' });
    topObserver.observe(sentinel);
}

// Empty user protocol messages (tool-result acknowledgements with no content)
// are noise in the transcript. Every page goes through this, not just the first.
function stripProtocolMessages(msgs) {
    return msgs.filter(function(m) {
        return !(m.role === 'user' && !m.content && !(m.tool_uses && m.tool_uses.length > 0));
    });
}

// Whole-session token usage, as recorded in the metadata index. The listing
// stores it with short keys; normalise to the shape totalTokens() expects.
function indexedSessionUsage() {
    var s = (currentSessions || []).find(function(x) { return x.id === currentSessionId; });
    if (!s || !s.usage || s.usage.input === undefined) return null;
    return {
        input_tokens: s.usage.input || 0,
        output_tokens: s.usage.output || 0,
        cache_read_input_tokens: s.usage.cache_read || 0,
        cache_creation_input_tokens: s.usage.cache_creation || 0,
    };
}

function renderConversation(conv) {
    // Record where this window sits in the session BEFORE filtering shrinks it.
    convWindowStart = conv.offset || 0;
    convWindowEnd = convWindowStart + (conv.messages ? conv.messages.length : 0);

    conv.messages = stripProtocolMessages(conv.messages);
    currentConversation = conv;
    lazyOffset = 0;
    if (typeof refreshBookmarkSet === 'function') refreshBookmarkSet();
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

    var sessionTokens = conv.messages.reduce(function(acc, m) {
        return acc + totalTokens(m.usage);
    }, 0);
    var sessionBreakdown = conv.messages.reduce(function(acc, m) {
        if (!m.usage) return acc;
        acc.input_tokens += m.usage.input_tokens || 0;
        acc.output_tokens += m.usage.output_tokens || 0;
        acc.cache_read_input_tokens += m.usage.cache_read_input_tokens || 0;
        acc.cache_creation_input_tokens += m.usage.cache_creation_input_tokens || 0;
        return acc;
    }, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });

    var header = document.createElement('div');
    header.className = 'conversation-header';
    var h1 = document.createElement('h1');
    h1.textContent = 'Session: ' + conv.session_id;
    var metaRow = document.createElement('div');
    metaRow.className = 'conversation-meta';
    // Report the SESSION's size, not the loaded window's. Showing
    // conv.messages.length here made a 91,660-message session read as "698
    // messages", which looks exactly like the conversation failed to load.
    var sessionTotal_ = (conv.total_messages != null) ? conv.total_messages : conv.messages.length;
    var countSpan = document.createElement('span');
    countSpan.textContent = sessionTotal_.toLocaleString() + ' messages';
    if (conv.total_messages != null && conv.messages.length < conv.total_messages) {
        countSpan.title = 'Showing the most recent ' + conv.messages.length.toLocaleString() +
            '; scroll to load earlier ones';
    }
    metaRow.appendChild(countSpan);

    // Token totals come from the index, which covers the whole session. Summing
    // the loaded window only would under-report it the same way.
    var indexed = indexedSessionUsage();
    var tokens = indexed ? totalTokens(indexed) : sessionTokens;
    if (tokens > 0) {
        var tokSpan = document.createElement('span');
        tokSpan.className = 'total-tokens';
        tokSpan.textContent = formatTokens(tokens) + ' tokens';
        tokSpan.title = tokenBreakdown(indexed || sessionBreakdown);
        metaRow.appendChild(tokSpan);
    }
    header.appendChild(h1);
    header.appendChild(metaRow);
    header.appendChild(buildSessionActions(conv));
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

    // A sentinel above the list as well as below it. With only a bottom one,
    // the list could grow in a single direction — after jumping to a bookmark
    // you sit mid-session and scrolling up hit the top of the window and stopped.
    var topSentinel = document.createElement('div');
    topSentinel.id = 'lazy-sentinel-top';
    topSentinel.className = 'lazy-sentinel';
    container.appendChild(topSentinel);

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
    var rawBtn = document.getElementById('export-raw-btn');
    if (exportBtn) exportBtn.disabled = false;
    if (copyBtn) copyBtn.disabled = false;
    if (rawBtn) rawBtn.disabled = false;
}
