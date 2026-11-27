// Building one message element.
//
// Elements are created and destroyed continuously by the virtual list, so
// nothing here may hold a reference that outlives the element: highlighting
// runs from an idle-time queue that drops detached blocks, rather than from an
// IntersectionObserver, which would keep every discarded node alive.

var LONG_MESSAGE_CHARS = 12000;   // longer pasted text renders truncated until asked
var MAX_HIGHLIGHT_BYTES = 50000;

var ASSISTANT_NAMES = { 'claude-code': 'Claude', 'codex': 'Codex', 'gemini': 'Gemini' };

function formatTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1000) return Math.round(n / 1000) + 'K';
    return String(n || 0);
}

function shortPath(cwd) {
    if (!cwd) return '';
    var parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
    return '~/' + (parts[parts.length - 1] || '');
}

function renderMarkdownInto(el, text) {
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
        el.textContent = text;
        return;
    }
    var html = marked.parse(text, { gfm: true, breaks: true, mangle: false, headerIds: false });
    el.innerHTML = DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
    el.querySelectorAll('pre code').forEach(queueHighlight);
}

var hlQueue = [];
var hlScheduled = false;
var idleCallback = window.requestIdleCallback || function(cb) {
    return setTimeout(function() { cb({ timeRemaining: function() { return 8; } }); }, 40);
};

function queueHighlight(block) {
    if (typeof hljs === 'undefined' || block.textContent.length > MAX_HIGHLIGHT_BYTES) return;
    hlQueue.push(block);
    if (!hlScheduled) { hlScheduled = true; idleCallback(runHighlightQueue); }
}

function runHighlightQueue(deadline) {
    hlScheduled = false;
    while (hlQueue.length && deadline.timeRemaining() > 2) {
        var b = hlQueue.shift();
        if (b.isConnected) highlightBlock(b);
    }
    if (hlQueue.length) { hlScheduled = true; idleCallback(runHighlightQueue); }
}

function highlightBlock(block) {
    // Not dataset.highlighted: highlight.js sets that itself, and refuses
    // (with a console warning) to touch an element that already has it.
    if (block.dataset.hl) return;
    block.dataset.hl = '1';
    try {
        // Naming the fenced language skips auto-detection across every grammar.
        var cls = (block.className || '').match(/language-([\w-]+)/);
        if (cls && hljs.getLanguage(cls[1])) {
            block.innerHTML = hljs.highlight(block.textContent, { language: cls[1] }).value;
        } else {
            hljs.highlightElement(block);
        }
    } catch (e) { /* cosmetic; never break rendering */ }
}

function setPinState(btn, pinned) {
    btn.classList.toggle('pinned', pinned);
    btn.replaceChildren(icon(pinned ? 'star-fill' : 'star'));
    btn.title = pinned ? 'Remove bookmark' : 'Bookmark this message';
}

function messageTimeLabel(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    var sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString([], { month: 'short', day: 'numeric',
        year: sameYear ? undefined : 'numeric', hour: '2-digit', minute: '2-digit' });
}

function chip(text, cls, title) {
    var c = document.createElement('span');
    c.className = 'msg-chip' + (cls ? ' ' + cls : '');
    c.textContent = text;
    if (title) c.title = title;
    return c;
}

// One line that says what a tool call did, so collapsed calls are readable.
function toolSummary(tool) {
    var inp = tool.input;
    if (inp && typeof inp === 'object') {
        var v = inp.command || inp.file_path || inp.path || inp.pattern || inp.url ||
                inp.query || inp.description || inp.prompt || '';
        if (v) return String(v).replace(/\s+/g, ' ').slice(0, 160);
        try { return JSON.stringify(inp).slice(0, 160); } catch (e) { return ''; }
    }
    return String(inp == null ? '' : inp).replace(/\s+/g, ' ').slice(0, 160);
}

function buildMessageContent(m) {
    var content = document.createElement('div');
    content.className = 'message-content markdown';
    var text = m.content;
    if (text.length > LONG_MESSAGE_CHARS && !m._full) {
        renderMarkdownInto(content, text.slice(0, LONG_MESSAGE_CHARS));
        var more = document.createElement('button');
        more.className = 'show-full-btn';
        more.textContent = 'Show full message (' + text.length.toLocaleString() + ' characters)';
        more.onclick = function() {
            m._full = true;
            content.replaceWith(buildMessageContent(m));
        };
        var wrap = document.createElement('div');
        wrap.className = 'message-truncated';
        wrap.append(content, more);
        return wrap;
    }
    renderMarkdownInto(content, text);
    return content;
}

function buildMessageEl(msg) {
    var classes = 'message ' + msg.role;
    if (hasTools(msg)) classes += ' has-tools';
    if (msg.thinking) classes += ' has-thinking';
    if (hasText(msg)) classes += ' has-text';
    var el = document.createElement('article');
    el.className = classes;

    var anchor = bookmarkAnchor(msg, msg._i);
    el.setAttribute('data-anchor', anchor);
    el.dataset.i = String(msg._i);

    var head = document.createElement('header');
    head.className = 'message-header';

    var avatar = document.createElement('span');
    avatar.className = 'msg-avatar';
    avatar.appendChild(icon(msg.role === 'user' ? 'user' : 'spark'));
    head.appendChild(avatar);

    var role = document.createElement('span');
    role.className = 'message-role';
    role.textContent = msg.role === 'user' ? 'You' : (ASSISTANT_NAMES[currentSource] || 'Assistant');
    head.appendChild(role);

    if (msg.model) head.appendChild(chip(msg.model, 'model-badge'));

    var time = document.createElement('time');
    time.className = 'message-time';
    time.textContent = messageTimeLabel(msg.timestamp);
    if (msg.timestamp) time.title = new Date(msg.timestamp).toLocaleString();
    head.appendChild(time);

    if (msg.role === 'user') {
        if (msg.cwd) head.appendChild(chip(shortPath(msg.cwd), '', msg.cwd));
        if (msg.gitBranch) head.appendChild(chip('⎇ ' + msg.gitBranch, 'msg-branch'));
    }
    if (msg.usage) {
        head.appendChild(chip(formatTokens(totalTokens(msg.usage)) + ' tok', 'usage-info',
            tokenBreakdown(msg.usage)));
    }

    var spacer = document.createElement('span');
    spacer.className = 'msg-spacer';
    head.appendChild(spacer);

    var copy = document.createElement('button');
    copy.className = 'msg-action';
    copy.title = 'Copy message';
    copy.appendChild(icon('copy'));
    copy.onclick = function(e) {
        e.stopPropagation();
        var text = msg.content || msg.thinking ||
            (msg.tool_uses || []).map(function(t) { return t.name + ' ' + JSON.stringify(t.input, null, 2); }).join('\n\n');
        copyToClipboard(text).then(function(ok) { toast(ok ? 'Message copied' : 'Could not copy'); });
    };
    head.appendChild(copy);

    var pin = document.createElement('button');
    pin.className = 'msg-action pin-btn';
    setPinState(pin, isBookmarked(anchor));
    pin.onclick = function(e) {
        e.stopPropagation();
        toggleBookmark(msg, msg._i, anchor, pin);
    };
    head.appendChild(pin);
    el.appendChild(head);

    if (hasText(msg)) el.appendChild(buildMessageContent(msg));

    if (msg.thinking) {
        var block = document.createElement('div');
        var open = msg._think !== undefined ? msg._think : allThinkingExpanded;
        block.className = 'thinking-block' + (open ? ' expanded' : '');
        var th = document.createElement('button');
        th.className = 'thinking-header';
        th.append(icon('bulb'), document.createTextNode('Thinking'), icon('down', 'chev'));
        // Remembered on the message: the node itself is recycled on scroll.
        th.onclick = function() { msg._think = block.classList.toggle('expanded'); };
        var tc = document.createElement('div');
        tc.className = 'thinking-content';
        tc.textContent = msg.thinking;
        block.append(th, tc);
        el.appendChild(block);
    }

    if (hasTools(msg)) {
        var tools = document.createElement('div');
        tools.className = 'tool-uses';
        msg.tool_uses.forEach(function(tool) {
            var d = document.createElement('details');
            d.className = 'tool-use';
            var s = document.createElement('summary');
            var name = document.createElement('span');
            name.className = 'tool-name';
            name.append(icon('tool'), document.createTextNode(tool.name || 'tool'));
            var sum = document.createElement('span');
            sum.className = 'tool-summary';
            sum.textContent = toolSummary(tool);
            s.append(name, sum);
            var body = document.createElement('pre');
            body.className = 'tool-input';
            var fill = function() {
                if (!body.textContent) {
                    body.textContent = typeof tool.input === 'string'
                        ? tool.input : JSON.stringify(tool.input, null, 2);
                }
            };
            // Built on first open: most tool calls are never expanded.
            d.addEventListener('toggle', function() {
                tool._open = d.open;
                if (d.open) fill();
            });
            if (tool._open) { fill(); d.open = true; }
            d.append(s, body);
            tools.appendChild(d);
        });
        el.appendChild(tools);
    }
    return el;
}

// Decoration that depends on the current view rather than on the message.
function decorateMessageEl(el, m) {
    if (!el) return;
    var old = el.querySelector('.dup-badge');
    if (old) old.remove();
    var d = convDup[m._i];
    if (d && d.count > 1) {
        var b = document.createElement('span');
        b.className = 'dup-badge';
        b.textContent = '×' + d.count;
        var when = d.times.map(messageTimeLabel).filter(Boolean);
        b.title = 'Sent ' + d.count + ' times' + (when.length
            ? '. Other copies: ' + when.join('  ·  ') + (d.count - 1 > when.length ? '  ·  …' : '')
            : '');
        var spacer = el.querySelector('.msg-spacer');
        if (spacer) spacer.after(b);
    }
    el.classList.toggle('search-match', convSearchSet.has(m._i));
    el.classList.toggle('search-current', convSearchCurrentId === m._i);
}
