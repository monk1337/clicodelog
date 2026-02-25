import os
import signal
import subprocess
import threading
import time
import webbrowser

import uvicorn

from .config import DATA_DIR, SOURCES, SYNC_INTERVAL
from .sync import background_sync, sync_data

BANNER = r"""
   ____ _ _  ____          _      _
  / ___| (_)/ ___|___   __| | ___| |    ___   __ _
 | |   | | | |   / _ \ / _` |/ _ \ |   / _ \ / _` |
 | |___| | | |__| (_) | (_| |  __/ |__| (_) | (_| |
  \____|_|_|\____\___/ \__,_|\___|_____\___/ \__, |
                                              |___/
"""


def kill_process_on_port(port: int, max_retries: int = 3) -> bool:
    for attempt in range(max_retries):
        try:
            result = subprocess.run(["lsof", "-ti", f":{port}"], capture_output=True, text=True)
            if result.returncode == 0 and result.stdout.strip():
                for pid in result.stdout.strip().split("\n"):
                    print(f"⚠️  Port {port} in use by PID {pid} — killing...")
                    try:
                        os.kill(int(pid), signal.SIGKILL)
                    except (ProcessLookupError, Exception):
                        pass
                time.sleep(1.5)
                check = subprocess.run(["lsof", "-ti", f":{port}"], capture_output=True, text=True)
                if check.returncode != 0 or not check.stdout.strip():
                    print(f"✓ Port {port} is now free")
                    return True
            else:
                return True
        except FileNotFoundError:
            return True  # lsof not available
        except Exception as e:
            print(f"Warning: could not check port: {e}")
            return False

    print(f"❌ Failed to free port {port} after {max_retries} attempts")
    return False


def run_server(host: str = "127.0.0.1", port: int = 6126, skip_sync: bool = False, debug: bool = False) -> None:
    from .app import app  # local import avoids circular dependency at module level

    print(BANNER)
    print("  AI Conversation History Viewer")
    print("=" * 60)

    if not kill_process_on_port(port):
        print(f"\n❌ Could not free port {port}. Try: lsof -ti:{port} | xargs kill -9")
        return

    if not skip_sync:
        print("\nSyncing data from all sources...")
        for source_id, config in SOURCES.items():
            print(f"\n{config['name']}:")
            print(f"  Source: {config['source_dir']}")
            print(f"  Backup: {DATA_DIR / config['data_subdir']}")
            if sync_data(source_id=source_id):
                print("  ✓ Sync completed!")
            else:
                print("  ⚠ Could not sync — using existing local data if available.")
    else:
        print("\nSkipping initial sync (--no-sync)")

    print(f"\nBackground sync: every {SYNC_INTERVAL // 3600} hour(s)")
    threading.Thread(target=background_sync, daemon=True).start()
    print("Background sync thread started.")

    url = f"http://{host}:{port}"
    print(f"\nStarting server...")
    print(f"🌐 Opening {url} in your browser...")
    print("=" * 60)

    def _open_browser():
        time.sleep(1.5)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    threading.Thread(target=_open_browser, daemon=True).start()
    uvicorn.run(app, host=host, port=port, log_level="info" if debug else "warning")
