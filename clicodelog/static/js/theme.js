function setTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    document.getElementById('theme-icon').textContent = theme === 'light' ? '☀️' : '🌙';
    document.getElementById('theme-label').textContent = theme === 'light' ? 'Light' : 'Dark';
}

function toggleTheme() {
    setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light');
}

// Apply saved theme immediately on load
setTheme(localStorage.getItem('theme') || 'light');
