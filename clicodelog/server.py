import errno
import os
import signal
import socket
import sys
import subprocess
import threading
import time
import webbrowser

import uvicorn

from .config import DATA_DIR, SOURCES, SYNC_INTERVAL
from .logging_setup import get_logger, setup_logging
from .sync import background_sync, initial_sync

log = get_logger(__name__)

BANNER = r"""
   ____ _ _  ____          _      _
  / ___| (_)/ ___|___   __| | ___| |    ___   __ _
 | |   | | | |   / _ \ / _` |/ _ \ |   / _ \ / _` |
 | |___| | | |__| (_) | (_| |  __/ |__| (_) | (_| |
  \____|_|_|\____\___/ \__,_|\___|_____\___/ \__, |
                                              |___/
"""

_OWN_MARKERS = ("clicodelog", "uvicorn")


def _listener_pids(port: int) -> list[int]:
    """PIDs listening on port — not every process with a socket on it.

    `lsof -ti :{port}` also matches the remote end, so a browser tab holding a
    keep-alive connection to a previous instance was a match. Restarting could
    therefore SIGKILL the user's browser.
    """
    try:
        result = subprocess.run(
            ["lsof", "-ti", f"tcp:{port}", "-sTCP:LISTEN"],
            capture_output=True, text=True, timeout=10)
    except (FileNotFoundError, subprocess.SubprocessError):
        return []
    pids = []
    for line in result.stdout.split():
        try:
            pids.append(int(line))
        except ValueError:
            pass
    return pids


def _describe(pid: int) -> str:
    try:
        r = subprocess.run(["ps", "-p", str(pid), "-o", "command="],
                           capture_output=True, text=True, timeout=5)
        return r.stdout.strip()
    except (FileNotFoundError, subprocess.SubprocessError):
        return ""


def _port_is_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError as e:
            return e.errno not in (errno.EADDRINUSE, errno.EACCES)


def free_port(host: str, port: int) -> bool:
    """Make the port available, refusing to kill anything that isn't ours."""
    if _port_is_free(host, port):
        return True

    pids = _listener_pids(port)
    if not pids:
        print(f"\n  Port {port} is in use but the owning process could not be identified.")
        print(f"  Try a different port:  clicodelog --port {port + 1}")
        return False

    for pid in pids:
        cmd = _describe(pid)
        if not any(m in cmd.lower() for m in _OWN_MARKERS):
            print(f"\n  Port {port} is held by another program (PID {pid}):")
            print(f"    {cmd[:120]}")
            print(f"  Refusing to kill it. Use another port:  clicodelog --port {port + 1}")
            return False

        print(f"  Port {port} held by a previous clicodelog (PID {pid}) — stopping it...")
        try:
            os.kill(pid, signal.SIGTERM)          # let it shut down cleanly
        except ProcessLookupError:
            continue
        except PermissionError:
            print(f"  No permission to stop PID {pid}. Use another port.")
            return False

        for _ in range(30):
            time.sleep(0.1)
            if _port_is_free(host, port):
                return True
        try:
            os.kill(pid, signal.SIGKILL)          # only a confirmed stale instance
        except (ProcessLookupError, PermissionError):
            pass

    for _ in range(20):
        if _port_is_free(host, port):
            return True
        time.sleep(0.1)
    return False


def _warn_if_exposed(host: str) -> None:
    if host in ("127.0.0.1", "localhost", "::1"):
        return
    print("\n" + "!" * 68)
    print("  WARNING: binding to " + host + " exposes this server beyond your machine.")
    print("  clicodelog has NO authentication. Anyone who can reach this port can")
    print("  read every conversation you have had with your AI tools, including any")
    print("  secrets pasted into them, and can delete your bookmarks.")
    print("  Use --host 127.0.0.1 (the default) unless you are certain.")
    print("!" * 68)
    log.warning("Server bound to non-loopback host %s with no authentication", host)


def run_server(
    host: str = "127.0.0.1",
    port: int = 6126,
    skip_sync: bool = False,
    debug: bool = False,
    folder: str | None = None,
) -> None:
    from .app import app
    from . import sync as _sync

    setup_logging(debug)

    # Line-buffer stdout so the banner and the "Ready at" line appear straight
    # away when output is redirected to a file or a process manager, instead of
    # sitting in a block buffer until the process exits — which reads as the
    # app having failed to start.
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except (AttributeError, ValueError):
        pass

    print(BANNER)
    print("  AI Conversation History Viewer")
    print("=" * 60)

    if folder:
        _sync.folder_filter = folder
        print(f"\n  Folder filter active: only showing projects matching '{folder}'")

    _warn_if_exposed(host)

    if not free_port(host, port):
        return

    for source_id, config in SOURCES.items():
        print(f"  {config['name']:<14} {DATA_DIR / config['data_subdir']}")

    # Sync and index in the background so the UI is available immediately. The
    # data directory already holds the previous run's copy, which is exactly what
    # --no-sync has always relied on.
    if skip_sync:
        print("\n  Skipping initial sync (--no-sync)")
    else:
        print(f"\n  Syncing in the background; refreshes every {SYNC_INTERVAL // 3600}h")
    threading.Thread(target=initial_sync, args=(skip_sync,), daemon=True).start()
    threading.Thread(target=background_sync, daemon=True).start()

    url = f"http://{host}:{port}"
    print(f"\n  Ready at {url}")
    print("=" * 60)

    def _open_browser():
        # Poll the port instead of guessing with a fixed sleep.
        for _ in range(100):
            if not _port_is_free(host, port):
                break
            time.sleep(0.1)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=_open_browser, daemon=True).start()
    uvicorn.run(app, host=host, port=port, log_level="info" if debug else "warning")
