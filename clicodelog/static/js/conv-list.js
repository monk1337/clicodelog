// Virtualized message list.
//
// Only messages near the viewport exist in the DOM. The rest are represented
// by two spacers sized from measured heights (cached per message as m._h) or a
// running-average estimate, so the scrollbar still spans the whole loaded
// conversation. Loading all of a 22,751-message session used to leave 222,310
// DOM nodes behind; this holds the DOM to the window around the viewport.
//
// Reading position is an explicit anchor: the first visible message and its
// offset from the top. Every user scroll records it; every layout change —
// a message measured, the estimate recalibrated, a page arriving above, a
// filter rebuilding the list — puts that message back at that offset. Fixing
// up scrollTop by deltas instead lost the position whenever two of those
// happened in one frame.

var VL = null;
var VL_OVERSCAN = 1200;     // px rendered beyond each edge of the viewport
var VL_EDGE_ITEMS = 25;     // fetch more once the window is this close to an end
var VL_MAX_ITEMS = 160;     // never render more than this many at once
var VL_DEFAULT_H = 200;
var vlLastEst = 0;          // carried to the next list, so it starts calibrated

function getScrollEl() {
    return document.getElementById('conv-scroller') || document.scrollingElement;
}

function vlCreate(host) {
    vlDestroy();
    var scroller = getScrollEl();
    host.textContent = '';
    var mk = function(cls) { var d = document.createElement('div'); d.className = cls; return d; };
    var edgeTop = mk('vl-edge'), top = mk('vl-spacer'), items = mk('vl-items'),
        bottom = mk('vl-spacer'), edgeBottom = mk('vl-edge');
    host.append(edgeTop, top, items, bottom, edgeBottom);

    VL = {
        host: host, scroller: scroller, top: top, items: items, bottom: bottom,
        edgeTop: edgeTop, edgeBottom: edgeBottom,
        nodes: new Map(), first: -1, last: -1, anchor: null,
        offsets: null, posById: null, dirty: true,
        est: vlLastEst || VL_DEFAULT_H, measured: 0, sumH: 0, raf: 0, gen: 1,
    };
    VL.ro = new ResizeObserver(vlOnResize);
    VL.onScroll = function() { if (VL && !VL.raf) VL.raf = requestAnimationFrame(vlTick); };
    scroller.addEventListener('scroll', VL.onScroll, { passive: true });
    window.addEventListener('resize', VL.onScroll);
}

function vlDestroy() {
    if (!VL) return;
    VL.ro.disconnect();
    VL.scroller.removeEventListener('scroll', VL.onScroll);
    window.removeEventListener('resize', VL.onScroll);
    if (VL.raf) cancelAnimationFrame(VL.raf);
    VL.nodes.clear();
    VL = null;
}

function vlEnsureOffsets() {
    if (!VL.dirty && VL.offsets && VL.offsets.length === convView.length + 1) return;
    var n = convView.length;
    var off = new Float64Array(n + 1);
    var est = VL.est;
    for (var p = 0; p < n; p++) off[p + 1] = off[p] + (convView[p]._h || est);
    VL.offsets = off;
    VL.dirty = false;
}

function vlPosById(id) {
    if (!VL.posById) {
        VL.posById = new Map();
        for (var p = 0; p < convView.length; p++) VL.posById.set(convView[p]._i, p);
    }
    var p2 = VL.posById.get(id);
    return p2 === undefined ? -1 : p2;
}

// Nearest position to a message id that is not in the view (filtered out):
// ids run monotonically through convView, so binary-search them.
function vlNearestPos(id) {
    var n = convView.length;
    if (!n) return 0;
    var desc = msgOrder === 'newest';
    var lo = 0, hi = n - 1;
    while (lo < hi) {
        var mid = (lo + hi) >> 1;
        var v = convView[mid]._i;
        if (desc ? v > id : v < id) lo = mid + 1; else hi = mid;
    }
    return lo;
}

function vlScrollerTop() {
    var s = VL.scroller;
    return s === document.scrollingElement ? 0 : s.getBoundingClientRect().top;
}

// Position of the top spacer within the scroller's content.
function vlListTop() {
    return VL.top.getBoundingClientRect().top - vlScrollerTop() + VL.scroller.scrollTop;
}

function vlPosAt(y) {
    var off = VL.offsets, lo = 0, hi = off.length - 1;
    if (y <= 0) return 0;
    while (lo < hi) {
        var mid = (lo + hi + 1) >> 1;
        if (off[mid] <= y) lo = mid; else hi = mid - 1;
    }
    return lo;
}

// A scroll: lay out for the new position, then remember what is at the top.
function vlTick() {
    if (!VL) return;
    VL.raf = 0;
    vlLayout();
    VL.anchor = vlCaptureAnchor();
}

function vlLayout() {
    vlEnsureOffsets();
    var n = convView.length;
    var s = VL.scroller;
    var y = s.scrollTop - vlListTop();
    var first = Math.min(n, vlPosAt(y - VL_OVERSCAN));
    var last = Math.min(n, vlPosAt(y + s.clientHeight + VL_OVERSCAN) + 1);
    if (last - first > VL_MAX_ITEMS) last = first + VL_MAX_ITEMS;
    var changed = vlRender(first, last);
    vlMaybeFetch(first, last);
    vlUpdateEdges();
    vlUpdateFabs();
    if (changed && typeof onListRendered === 'function') onListRendered();
}

// After any layout change, put the anchored message back where the reader
// last saw it: first by the offsets (partly estimates), then exactly, by the
// rendered node.
function vlHoldAnchor() {
    var a = VL.anchor;
    if (!a || !convView.length) { vlLayout(); VL.anchor = vlCaptureAnchor(); return; }
    vlEnsureOffsets();
    var p = vlPosById(a.id);
    if (p < 0) p = Math.min(vlNearestPos(a.id), convView.length - 1);
    var id = convView[p]._i;
    vlSetScroll(vlListTop() + VL.offsets[p] - a.delta);
    vlLayout();
    // Correcting can bring new, not-yet-measured items into range above the
    // anchor, which moves it again; repeat until it stays put.
    for (var tries = 0; tries < 5; tries++) {
        var node = VL.nodes.get(id);
        if (!node) break;
        var diff = node.getBoundingClientRect().top - vlScrollerTop() - a.delta;
        if (Math.abs(diff) < 0.5) break;
        vlSetScroll(VL.scroller.scrollTop + diff);
        vlLayout();
    }
    if (id !== a.id) VL.anchor = { id: id, delta: a.delta };
}

function vlRender(first, last) {
    var n = convView.length;
    var sameRange = first === VL.first && last === VL.last;
    if (!sameRange) {
        var keep = new Map();
        var list = [];
        for (var p = first; p < last; p++) {
            var m = convView[p];
            var el = VL.nodes.get(m._i);
            if (!el) {
                el = vlBuildItem(m);
                VL.ro.observe(el);
            }
            keep.set(m._i, el);
            list.push(el);
        }
        VL.nodes.forEach(function(el, id) { if (!keep.has(id)) VL.ro.unobserve(el); });
        VL.nodes = keep;
        VL.items.replaceChildren.apply(VL.items, list);
    }
    VL.top.style.height = VL.offsets[first] + 'px';
    VL.bottom.style.height = (VL.offsets[n] - VL.offsets[last]) + 'px';
    VL.first = first;
    VL.last = last;
    return vlDecorate() > 0 || !sameRange;
}

function vlBuildItem(m) {
    var wrap = document.createElement('div');
    wrap.className = 'vl-item';
    wrap.__msg = m;
    wrap.appendChild(buildMessageEl(m));
    return wrap;
}

// Per-render decoration that depends on the view rather than the message:
// repeat counts, search hits. Cheap, and skipped when nothing changed.
function vlDecorate() {
    var n = 0;
    VL.nodes.forEach(function(el) {
        if (el.__gen === VL.gen) return;
        el.__gen = VL.gen;
        decorateMessageEl(el.firstChild, el.__msg);
        n++;
    });
    return n;
}

function vlOnResize(entries) {
    if (!VL) return;
    var changed = false;
    entries.forEach(function(en) {
        var el = en.target, m = el.__msg;
        if (!m || !el.isConnected) return;
        var h = el.offsetHeight;
        if (h <= 0 || Math.abs(h - (m._h || 0)) < 0.5) return;
        if (!m._h) { VL.measured++; VL.sumH += h; } else { VL.sumH += h - m._h; }
        m._h = h;
        changed = true;
    });
    if (!changed) return;
    // Recalibrate on a growing schedule, not on every measurement, so the
    // scrollbar doesn't twitch.
    if (VL.measured >= (VL.nextEst || 8)) {
        VL.est = vlLastEst = Math.max(60, Math.round(VL.sumH / VL.measured));
        VL.nextEst = Math.ceil(VL.measured * 1.5);
    }
    VL.dirty = true;
    vlHoldAnchor();
}

// The first visible message and how far its top sits from the viewport top.
function vlCaptureAnchor() {
    if (!VL) return null;
    var sTop = vlScrollerTop();
    var kids = VL.items.children;
    for (var k = 0; k < kids.length; k++) {
        var r = kids[k].getBoundingClientRect();
        if (r.bottom > sTop + 1) return { id: kids[k].__msg._i, delta: r.top - sTop };
    }
    return null;
}

// Call after buildView() changed convView. Keeps the anchor message in place
// unless told to go to the top.
function vlRebuild(opts) {
    if (!VL) return;
    opts = opts || {};
    var anchor = opts.anchor !== undefined ? opts.anchor : (vlCaptureAnchor() || VL.anchor);
    VL.posById = null;
    VL.dirty = true;
    VL.first = VL.last = -1;
    VL.gen++;
    if (opts.scrollTo === 'top' || !anchor || !convView.length) {
        vlEnsureOffsets();
        VL.scroller.scrollTop = 0;
        vlLayout();
        VL.anchor = vlCaptureAnchor();
        return;
    }
    VL.anchor = anchor;
    vlHoldAnchor();
}

// Set scrollTop for a layout the DOM may not reflect yet. Pages that just
// arrived are in the offsets but not in the spacers, and the browser clamps
// scrollTop to the content it has: a page prepended above the reader threw
// them hundreds of messages away. Grow the content first, then scroll.
function vlSetScroll(y) {
    var s = VL.scroller;
    y = Math.max(0, y);
    var need = y + s.clientHeight - s.scrollHeight;
    if (need > 0) VL.bottom.style.height = ((parseFloat(VL.bottom.style.height) || 0) + need) + 'px';
    s.scrollTop = y;
}

function vlRedecorate() {
    if (!VL) return;
    VL.gen++;
    vlDecorate();
    if (typeof onListRendered === 'function') onListRendered();
}

function vlNodeFor(id) {
    var el = VL && VL.nodes.get(id);
    return el ? el.firstChild : null;
}
