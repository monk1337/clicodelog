// Focus view: one conversation at full width. Opened from "Open in a focused
// tab", from a bookmark in another conversation, or from a search result here.
(function initFocusView() {
    var p = new URLSearchParams(window.location.search);
    currentProjectId = p.get('project');
    currentSessionId = p.get('session');
    currentSource = p.get('source') || 'claude-code';
    var anchor = p.get('anchor');

    installShortcuts();
    fetchSyncStatus();
    loadBookmarks();

    // No project or session panes here: a result for this conversation jumps
    // in place, anything else opens in another focus tab.
    window.selectSearchResult = function(projectId, sessionId, anchorUuid) {
        if (projectId === currentProjectId && sessionId === currentSessionId) {
            if (anchorUuid && !scrollToAnchor(anchorUuid)) openAtAnchor(anchorUuid);
            return;
        }
        window.open('/view?source=' + encodeURIComponent(currentSource) +
            '&project=' + encodeURIComponent(projectId) +
            '&session=' + encodeURIComponent(sessionId) +
            (anchorUuid ? '&anchor=' + encodeURIComponent(anchorUuid) : ''), '_blank', 'noopener');
    };

    if (!currentProjectId || !currentSessionId) {
        showConvError('This link is missing its project or session.');
        return;
    }
    if (anchor) { openAtAnchor(anchor); return; }

    var seq = ++sessionRequestSeq;
    showConvLoading();
    fetch(conversationUrl('limit=' + CONV_PAGE + (msgOrder === 'newest' ? '&tail=true' : '')))
        .then(function(r) {
            return r.json().then(function(conv) {
                if (!r.ok || !conv || conv.error || !Array.isArray(conv.messages)) {
                    throw new Error((conv && conv.error) || 'HTTP ' + r.status);
                }
                return conv;
            });
        })
        .then(function(conv) { if (seq === sessionRequestSeq) renderConversation(conv); })
        .catch(function(e) {
            if (seq === sessionRequestSeq) showConvError('Could not load this conversation: ' + e.message);
        });
})();
