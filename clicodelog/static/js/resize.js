(function initResizableColumns() {
    const handles = [
        { el: document.getElementById('resize-handle-1'), panel: document.getElementById('projects-panel') },
        { el: document.getElementById('resize-handle-2'), panel: document.getElementById('sessions-panel') },
    ];

    try {
        const saved = JSON.parse(localStorage.getItem('columnWidths'));
        if (saved) {
            if (saved.projects) handles[0].panel.style.width = saved.projects + 'px';
            if (saved.sessions) handles[1].panel.style.width = saved.sessions + 'px';
        }
    } catch (e) {}

    handles.forEach(function({ el, panel }) {
        el.addEventListener('mousedown', function(e) {
            e.preventDefault();
            var startX = e.clientX;
            var startWidth = panel.offsetWidth;
            var minW = parseInt(getComputedStyle(panel).minWidth) || 100;
            var maxW = parseInt(getComputedStyle(panel).maxWidth) || 800;
            el.classList.add('dragging');
            document.body.classList.add('resizing');

            function onMove(e) {
                panel.style.width = Math.min(maxW, Math.max(minW, startWidth + (e.clientX - startX))) + 'px';
            }
            function onUp() {
                el.classList.remove('dragging');
                document.body.classList.remove('resizing');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                localStorage.setItem('columnWidths', JSON.stringify({
                    projects: handles[0].panel.offsetWidth,
                    sessions: handles[1].panel.offsetWidth,
                }));
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
})();

// Reserve exactly as much room as the fixed toolbar takes. It wraps onto a
// second row when the window is narrow, and a fixed 60px offset let that row
// sit on top of the conversation's filter bar.
(function trackToolbarHeight() {
    var bar = document.querySelector('.top-controls');
    if (!bar) return;
    function update() {
        var bottom = Math.ceil(bar.getBoundingClientRect().bottom);
        document.documentElement.style.setProperty('--controls-h', Math.max(60, bottom + 4) + 'px');
    }
    update();
    if ('ResizeObserver' in window) new ResizeObserver(update).observe(bar);
    window.addEventListener('resize', update);
})();
