#!/usr/bin/env python3
"""
1B Human Speech System — entry point.

Launches the FastAPI server (serves the digital-face web app + WebSocket)
and opens the browser.

Usage:
    python3 run.py                # default: port 8000
    python3 run.py --port 9000    # custom port
    python3 run.py --no-browser   # don't auto-open a browser
"""
from __future__ import annotations

import argparse
import logging
import threading
import time
import webbrowser

import uvicorn

from server import create_app

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(name)-12s %(levelname)-6s %(message)s",
)


def open_browser(port: int) -> None:
    time.sleep(1.4)
    webbrowser.open(f"http://localhost:{port}")


def main() -> None:
    parser = argparse.ArgumentParser(description="1B Human Speech System")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-browser", action="store_true", help="Do not auto-open browser")
    args = parser.parse_args()

    app = create_app()

    if not args.no_browser:
        threading.Thread(target=open_browser, args=(args.port,), daemon=True).start()

    print("\n  1B Human Speech System")
    print("  =======================")
    print(f"  →  http://localhost:{args.port}")
    print("  →  press Ctrl+C to stop\n")

    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="info")


if __name__ == "__main__":
    main()
