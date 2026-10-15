"""
FastAPI server: serves the web face UI, handles WebSocket connections,
and routes chat messages into the Conductor.
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from brain import Conductor, PERSONAS

log = logging.getLogger("server")
WEB_DIR = Path(__file__).resolve().parent.parent / "web"


def create_app() -> FastAPI:
    app = FastAPI(title="1B Human Speech System")
    conductor = Conductor(model="llama3.2:1b")
    app.state.conductor = conductor

    app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")

    @app.get("/")
    async def index() -> FileResponse:
        return FileResponse(WEB_DIR / "index.html")

    @app.get("/api/personas")
    async def personas() -> dict:
        return {"personas": list(PERSONAS.keys()), "current": conductor.persona_key}

    @app.post("/api/personas/{key}")
    async def set_persona(key: str) -> dict:
        ok = conductor.set_persona(key)
        return {"ok": ok, "current": conductor.persona_key}

    @app.websocket("/ws")
    async def ws_endpoint(ws: WebSocket):
        await ws.accept()
        conductor.register(ws)
        try:
            # Send the client everything it needs to boot.
            await ws.send_text(
                '{"type":"hello","persona":"%s","personas":%s}'
                % (conductor.persona_key, json_dumps(list(PERSONAS.keys())))
            )
            while True:
                data = await ws.receive_text()
                import json
                try:
                    msg = json.loads(data)
                except json.JSONDecodeError:
                    continue
                mtype = msg.get("type")
                if mtype == "speak":
                    line = (msg.get("line") or "").strip()
                    if line:
                        await conductor.speak(line)
                elif mtype == "set_persona":
                    ok = conductor.set_persona(msg.get("key", ""))
                    await ws.send_text(
                        '{"type":"persona_changed","ok":%s,"current":"%s"}'
                        % ("true" if ok else "false", conductor.persona_key)
                    )
                elif mtype == "interrupt":
                    await ws.send_text('{"type":"info","msg":"Interrupt coming soon."}')
        except WebSocketDisconnect:
            pass
        finally:
            conductor.unregister(ws)

    return app


def json_dumps(obj):
    import json
    return json.dumps(obj)
