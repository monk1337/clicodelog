// Draggable column widths, remembered across visits.
(function initResizableColumns() {
    var handles = [
        { el: document.getElementById('resize-handle-1'), panel: document.getElementById('projects-panel') },
        { el: document.getElementById('resize-handle-2'), panel: document.getElementById('sessions-panel') },
    ].filter(function(h) { return h.el && h.panel; });
    if (!handles.length) return;

    try {
        var saved = JSON.parse(localStorage.getItem('columnWidths'));
        if (saved) {
            if (saved.projects && handles[0]) handles[0].panel.style.width = saved.projects + 'px';
            if (saved.sessions && handles[1]) handles[1].panel.style.width = saved.sessions + 'px';
        }
    } catch (e) { /* ignore */ }

    function save() {
        try {
            localStorage.setItem('columnWidths', JSON.stringify({
                projects: handles[0] ? handles[0].panel.offsetWidth : undefined,
                sessions: handles[1] ? handles[1].panel.offsetWidth : undefined,
            }));
        } catch (e) { /* ignore */ }
    }

    handles.forEach(function(h) {
        h.el.addEventListener('pointerdown', function(e) {
            e.preventDefault();
            var startX = e.clientX;
            var startWidth = h.panel.offsetWidth;
            var cs = getComputedStyle(h.panel);
            var minW = parseInt(cs.minWidth, 10) || 160;
            var maxW = parseInt(cs.maxWidth, 10) || 800;
            h.el.classList.add('dragging');
            document.body.classList.add('resizing');
            h.el.setPointerCapture(e.pointerId);

            function onMove(ev) {
                h.panel.style.width = Math.min(maxW, Math.max(minW, startWidth + (ev.clientX - startX))) + 'px';
            }
            function onUp() {
                h.el.classList.remove('dragging');
                document.body.classList.remove('resizing');
                h.el.removeEventListener('pointermove', onMove);
                h.el.removeEventListener('pointerup', onUp);
                h.el.removeEventListener('pointercancel', onUp);
                save();
            }
            h.el.addEventListener('pointermove', onMove);
            h.el.addEventListener('pointerup', onUp);
            h.el.addEventListener('pointercancel', onUp);
        });
        // Double-click restores the default width.
        h.el.addEventListener('dblclick', function() { h.panel.style.width = ''; save(); });
    });
})();
