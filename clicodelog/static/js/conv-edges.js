// The virtual list's ends: paging more of the session in as the reader nears
// either end, the edge labels, and scrolling to a message or an end.

// Bring a message on screen. Positions from estimates are approximate, so
// land roughly, let it render and measure, then settle on the real element.
function vlScrollToId(id, align, done) {
    if (!VL) return;
    vlEnsureOffsets();
    var p = vlPosById(id);
    if (p < 0) { if (done) done(null); return; }
    var s = VL.scroller;
    var h = VL.offsets[p + 1] - VL.offsets[p];
    var y = vlListTop() + VL.offsets[p];
    vlSetScroll(align === 'start' ? y - 72 : y - (s.clientHeight - h) / 2);
    vlTick();
    var tries = 0;
    (function settle() {
        requestAnimationFrame(function() {
            var el = vlNodeFor(id);
            if (el) el.scrollIntoView({ block: align === 'start' ? 'start' : 'center' });
            if (++tries < 3) settle(); else if (done) done(vlNodeFor(id));
        });
    })();
}

// Each jump button shows only when there is somewhere to jump to.
function vlUpdateFabs() {
    var fabs = document.getElementById('jump-fabs');
    if (!fabs || !VL) return;
    var s = VL.scroller;
    var far = s.clientHeight * 0.75;
    fabs.classList.toggle('can-top', s.scrollTop > far);
    fabs.classList.toggle('can-bottom', s.scrollHeight - s.clientHeight - s.scrollTop > far);
}

function vlScrollToEdge(edge) {
    if (!VL) return;
    var s = VL.scroller, tries = 0;
    (function go() {
        s.scrollTop = edge === 'top' ? 0 : s.scrollHeight;
        vlTick();
        if (++tries < 4) requestAnimationFrame(go);
    })();
}

// Which server direction each end of the list needs depends on the order:
// newest-first puts newer messages at the top, oldest-first the reverse.
function vlEdgeWantsOlder(edge) {
    return edge === 'top' ? msgOrder !== 'newest' : msgOrder === 'newest';
}

function vlEdgeHasMore(edge) {
    return vlEdgeWantsOlder(edge) ? hasOlderOnServer() : hasNewerOnServer();
}

function vlMaybeFetch(first, last) {
    if (!currentConversation || currentConversation._busy) return;
    var n = convView.length;
    if (first <= VL_EDGE_ITEMS && vlEdgeHasMore('top')) vlFetchEdge('top');
    else if (last >= n - VL_EDGE_ITEMS && vlEdgeHasMore('bottom')) vlFetchEdge('bottom');
}

async function vlFetchEdge(edge) {
    var vl = VL;
    vl.loadingEdge = edge;
    vlUpdateEdges();
    var grew = await extendConversation(vlEdgeWantsOlder(edge), CONV_PAGE);
    if (VL !== vl) return;           // another conversation took over
    VL.loadingEdge = null;
    if (grew) {
        buildView();
        vlRebuild();
        updateConvStatus();
    } else {
        vlUpdateEdges();
    }
}

function vlUpdateEdges() {
    if (!VL) return;
    ['top', 'bottom'].forEach(function(edge) {
        var el = edge === 'top' ? VL.edgeTop : VL.edgeBottom;
        var more = vlEdgeHasMore(edge);
        var older = vlEdgeWantsOlder(edge);
        var text = '';
        if (more) text = (VL.loadingEdge === edge ? 'Loading ' : 'Scroll for ') +
            (older ? 'earlier messages' : 'newer messages') + '…';
        else if (convView.length && older) text = 'Beginning of conversation';
        el.textContent = text;
        el.classList.toggle('loading', VL.loadingEdge === edge);
        // Fixed height either way: showing or hiding a label above the list
        // must not move the messages under the reader.
        el.style.visibility = text ? '' : 'hidden';
    });
    if (!convView.length) {
        var empty = VL.items.querySelector('.vl-empty');
        if (!empty) {
            empty = document.createElement('div');
            empty.className = 'vl-empty';
            VL.items.appendChild(empty);
        }
        empty.textContent = hasMoreOnServer()
            ? 'Looking further back for matching messages…'
            : 'No messages match these filters.';
    }
}
