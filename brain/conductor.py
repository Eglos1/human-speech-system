"""
Conductor: turns a user prompt into a live stream of raw-muscle frames.

Pipeline: prompt -> persona system prompt -> LLM stream -> line buffer ->
parse each line -> forward frame to every connected WebSocket client.
"""
from __future__ import annotations

import asyncio
import json
import logging

from .llm import LLMClient
from .parser import parse_line, muscles_to_short
from .persona import build_system_prompt, PERSONAS

log = logging.getLogger("conductor")


class Conductor:
    def __init__(self, model: str = "llama3.2:1b"):
        self.llm = LLMClient(model=model)
        self.persona_key = "maya"
        self.persona = PERSONAS[self.persona_key]
        self._connections: set = set()
        self._lock = asyncio.Lock()
        self._history: list[dict] = []   # recent chat for context
        self.busy = False

    # ---- connection management ------------------------------------------------
    def register(self, ws) -> None:
        self._connections.add(ws)

    def unregister(self, ws) -> None:
        self._connections.discard(ws)

    async def broadcast(self, message: dict) -> None:
        """Send a JSON message to all connected clients (fire-and-forget)."""
        payload = json.dumps(message)
        dead = []
        for ws in list(self._connections):
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self._connections.discard(ws)

    # ---- the actual speech -----------------------------------------------------
    def set_persona(self, key: str) -> bool:
        if key in PERSONAS:
            self.persona_key = key
            self.persona = PERSONAS[key]
            return True
        return False

    def _build_user_prompt(self, user_line: str) -> str:
        context = ""
        if self._history:
            recent = "\n".join(
                f"{'Human' if h['role'] == 'user' else self.persona['name']}: {h['text']}"
                for h in self._history[-6:]
            )
            context = f"RECENT CONVERSATION\n{recent}\n\n"
        return (
            f"{context}"
            f"Human says: {user_line}\n\n"
            f"Your reply lines:\n"
        )

    async def speak(self, user_line: str) -> None:
        """Handle a user line: think, then stream muscle frames to clients.

        The 1B model occasionally produces a reply with no spoken words at
        all — retry the turn once so the character doesn't fall silent.
        """
        if self.busy:
            await self.broadcast({"type": "info", "msg": "Still speaking, one at a time!"})
            return
        self.busy = True
        try:
            await self.broadcast({"type": "thinking", "on": True})
            # Let the face do a micro idle-sway while the model "thinks".
            await asyncio.sleep(0.15)

            total_frames = 0
            for attempt in range(2):
                # The persona+format block works best inlined in the prompt
                # (not as a separate system message) — tested on llama3.2:1b.
                persona_block = build_system_prompt(self.persona)
                prompt = persona_block + "\n\n" + self._build_user_prompt(user_line)
                log.info("prompt (%s) -> %s (persona=%s)",
                         "retry" if attempt else "turn", user_line, self.persona_key)

                prev_muscles: dict | None = None
                buffer = ""
                frames_this = 0
                words_this = 0

                async for chunk in self.llm.stream(prompt, system=""):
                    buffer += chunk
                    # Process complete lines as they arrive.
                    while "\n" in buffer:
                        raw_line, buffer = buffer.split("\n", 1)
                        frame = parse_line(raw_line, prev_muscles)
                        if frame is not None:
                            prev_muscles = frame.muscles
                            await self.broadcast({
                                "type": "frame",
                                "muscles": muscles_to_short(frame.muscles),
                                "words": frame.words,
                                "persona": self.persona["name"],
                            })
                            frames_this += 1
                            if frame.words.strip():
                                words_this += 1

                # Trailing line without newline.
                if buffer.strip():
                    frame = parse_line(buffer, prev_muscles)
                    if frame is not None:
                        await self.broadcast({
                            "type": "frame",
                            "muscles": muscles_to_short(frame.muscles),
                            "words": frame.words,
                            "persona": self.persona["name"],
                        })
                        frames_this += 1
                        if frame.words.strip():
                            words_this += 1

                total_frames += frames_this
                if words_this:
                    break  # the character said something

            await self.broadcast({"type": "speech_end", "frames": total_frames})
            log.info("done, %d frames", total_frames)
        except Exception as exc:  # noqa: BLE001
            log.exception("speak failed")
            await self.broadcast({"type": "error", "msg": f"LLM error: {exc}"})
        finally:
            self.busy = False
            await self.broadcast({"type": "thinking", "on": False})
