"""Command-line interface for cli code log."""

import argparse

from clicodelog import __version__


def main():
    """Main entry point for the CLI."""
    parser = argparse.ArgumentParser(
        prog="clicodelog",
        description="Browse, inspect, and export logs from CLI-based AI coding agents",
    )
    parser.add_argument(
        "--version", "-V",
        action="version",
        version=f"%(prog)s {__version__}",
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=6126,
        help="Port to run the server on (default: 6126)",
    )
    parser.add_argument(
        "--host", "-H",
        type=str,
        default="127.0.0.1",
        help="Host to bind to (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--no-sync",
        action="store_true",
        help="Skip initial data sync on startup",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Run in debug mode",
    )

    args = parser.parse_args()

    # Import here to avoid slow startup for --help/--version
    from clicodelog.app import run_server

    run_server(
        host=args.host,
        port=args.port,
        skip_sync=args.no_sync,
        debug=args.debug,
    )


if __name__ == "__main__":
    main()
