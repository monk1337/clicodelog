// Light / dark. With no saved choice the page follows the system setting; the
// inline script in each template applies it before first paint.

function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

function paintThemeButton(theme) {
    var use = document.querySelector('#theme-icon use');
    if (use) use.setAttribute('href', theme === 'dark' ? '#i-sun' : '#i-moon');
    var btn = document.getElementById('theme-btn');
    if (btn) btn.title = theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
}

function setTheme(theme, persist) {
    document.documentElement.setAttribute('data-theme', theme);
    if (persist) {
        try { localStorage.setItem('theme', theme); } catch (e) { /* ignore */ }
    }
    paintThemeButton(theme);
}

function toggleTheme() {
    setTheme(currentTheme() === 'light' ? 'dark' : 'light', true);
}

(function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem('theme'); } catch (e) { /* ignore */ }
    var media = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
    setTheme(saved || (media && media.matches ? 'dark' : 'light'), false);
    if (media && media.addEventListener) {
        media.addEventListener('change', function(e) {
            var stillSystem = true;
            try { stillSystem = !localStorage.getItem('theme'); } catch (err) { /* ignore */ }
            if (stillSystem) setTheme(e.matches ? 'dark' : 'light', false);
        });
    }
})();
