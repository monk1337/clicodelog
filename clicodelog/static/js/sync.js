// Sync status and the manual Sync button. The status poll runs only while the
// page is visible: a background tab polling every minute kept the server busy
// for nobody, and stopped it from ever counting as idle.

var SYNC_POLL_MS = 60000;
var syncPollTimer = null;

async function fetchSyncStatus() {
    try {
        var data = await fetch('/api/status?source=' + encodeURIComponent(currentSource)).then(function(r) { return r.json(); });
        updateSyncStatus(data.last_sync);
    } catch (e) {
        var el = document.getElementById('sync-status');
        if (el) el.textContent = 'Offline';
    }
}

function updateSyncStatus(lastSync) {
    var el = document.getElementById('sync-status');
    if (!el) return;
    if (lastSync) {
        var d = new Date(lastSync);
        el.textContent = 'Synced ' + relativeTime(lastSync);
        el.title = 'Last sync: ' + d.toLocaleString();
    } else {
        el.textContent = 'Not synced';
        el.title = '';
    }
}

async function manualSync() {
    var btn = document.getElementById('sync-btn');
    var status = document.getElementById('sync-status');
    if (btn) { btn.classList.add('syncing'); btn.disabled = true; }
    if (status) status.textContent = 'Syncing…';
    try {
        var data = await fetch('/api/sync?source=' + encodeURIComponent(currentSource), { method: 'POST' })
            .then(function(r) { return r.json(); });
        if (data.status === 'success') {
            updateSyncStatus(data.last_sync);
            cacheClear();
            if (typeof loadProjects === 'function') await loadProjects();
            toast('Sync complete');
        } else if (status) {
            status.textContent = 'Sync failed';
        }
    } catch (e) {
        if (status) status.textContent = 'Sync error';
    } finally {
        if (btn) { btn.classList.remove('syncing'); btn.disabled = false; }
    }
}

function scheduleSyncPoll() {
    clearInterval(syncPollTimer);
    syncPollTimer = null;
    if (!document.hidden) syncPollTimer = setInterval(fetchSyncStatus, SYNC_POLL_MS);
}

document.addEventListener('visibilitychange', function() {
    if (!document.hidden) fetchSyncStatus();
    scheduleSyncPoll();
});

scheduleSyncPoll();
