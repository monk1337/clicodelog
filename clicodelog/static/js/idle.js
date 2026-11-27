// Tab discarding, the way a browser's memory saver treats background tabs.
//
// A conversation tab holds everything it has loaded: the messages (tens of MB
// for a long session after "Load all"), the per-message measurements, and up
// to four cached sessions. Once the page has gone unused for IDLE_MS — hidden,
// or visible in an unfocused window with no input — all of that is dropped and
// only a restore point is kept.
//
// What is on screen stays on screen as an inert snapshot, so discarding is
// invisible. The first interaction reloads one window around the message in
// view and puts it back at the same position.
//
// A focused, visible tab is never discarded: that is a tab in use.

var IDLE_MS = 5 * 60 * 1000;
var idleLastActive = Date.now();
var idleDiscarded = null;           // restore point while discarded
var idleRestoring = false;

(function() {
    // ?idle=10 shortens the timeout to 10 seconds, for trying this out.
    var q = new URLSearchParams(location.search).get('idle');
    if (q && /^\d+$/.test(q)) IDLE_MS = Math.max(1, Number(q)) * 1000;
})();

function idleNoteActivity() {
    idleLastActive = Date.now();
    if (idleDiscarded && !idleRestoring) restoreDiscardedTab();
}

['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus', 'scroll'].forEach(function(ev) {
    window.addEventListener(ev, idleNoteActivity, { passive: true, capture: true });
});

document.addEventListener('visibilitychange', function() {
    if (!document.hidden) idleNoteActivity();
});

function idleHasSomethingToFree() {
    return !!(currentConversation || conversationCache.size);
}

function idleCheck() {
    if (idleDiscarded || idleRestoring || !idleHasSomethingToFree()) return;
    if (!document.hidden && document.hasFocus()) {
        idleLastActive = Date.now();
        return;
    }
    if (Date.now() - idleLastActive >= IDLE_MS) discardTab();
}

setInterval(idleCheck, Math.max(1000, Math.min(30000, IDLE_MS / 4)));

// The first message whose bottom edge is below the top of the scroller, and
// how far its top sits from the scroller's top, read from whatever is rendered.
function snapshotAnchor() {
    var scroller = getScrollEl();
    var box = document.getElementById('messages-container');
    if (!scroller || !box) return null;
    var top = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    var items = box.querySelectorAll('.vl-item');
    for (var k = 0; k < items.length; k++) {
        var r = items[k].getBoundingClientRect();
        if (r.bottom > top + 1 && items[k].__msg) return { id: items[k].__msg._i, delta: r.top - top };
    }
    return null;
}

function discardTab() {
    idleDiscarded = {
        source: currentSource,
        project: currentProjectId,
        session: currentSessionId,
        hadConversation: !!currentConversation,
        anchor: VL ? vlCaptureAnchor() : null,
    };
    // Stop the list (observers, listeners, measurements) but leave its rendered
    // items where they are; they reference only the handful of messages shown.
    vlDestroy();
    currentConversation = null;
    convView = [];
    convDup = {};
    revealedIds.clear();
    cacheClear();
    if (typeof hlQueue !== 'undefined') hlQueue.length = 0;
    if (typeof clearFindHighlights === 'function') clearFindHighlights();
    document.body.classList.add('tab-discarded');
}

function restoreDiscardedTab() {
    var s = idleDiscarded;
    idleDiscarded = null;
    document.body.classList.remove('tab-discarded');
    if (!s || !s.hadConversation) return;
    // The reader moved on while it was discarded; nothing to bring back.
    if (s.session !== currentSessionId || s.source !== currentSource || !currentSessionId) return;
    var anchor = snapshotAnchor() || s.anchor;
    idleRestoring = true;
    Promise.resolve(reopenAround(anchor)).finally(function() {
        idleRestoring = false;
        idleLastActive = Date.now();
    });
}
