async function fetchSyncStatus() {
    try {
        const data = await fetch('/api/status?source=' + currentSource).then(r => r.json());
        updateSyncStatus(data.last_sync);
    } catch (e) {
        document.getElementById('sync-status').textContent = 'Status unavailable';
    }
}

function updateSyncStatus(lastSync) {
    const el = document.getElementById('sync-status');
    if (lastSync) {
        const d = new Date(lastSync);
        el.textContent = 'Last sync: ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        el.title = 'Last sync: ' + d.toLocaleString();
    } else {
        el.textContent = 'Not synced';
    }
}

async function manualSync() {
    const btn = document.getElementById('sync-btn');
    btn.classList.add('syncing');
    btn.disabled = true;
    document.getElementById('sync-status').textContent = 'Syncing...';
    try {
        const data = await fetch('/api/sync?source=' + currentSource, { method: 'POST' }).then(r => r.json());
        if (data.status === 'success') {
            updateSyncStatus(data.last_sync);
            conversationCache = {};
            await loadProjects();
        } else {
            document.getElementById('sync-status').textContent = 'Sync failed';
        }
    } catch (e) {
        document.getElementById('sync-status').textContent = 'Sync error';
    } finally {
        btn.classList.remove('syncing');
        btn.disabled = false;
    }
}

fetchSyncStatus();
setInterval(fetchSyncStatus, 60000);
