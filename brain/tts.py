"""
Server-side TTS: turns the LLM's spoken words into actual audio.

The 1B LLM marks emphasis with lightweight tags:
    *word*     -> stress it (strong emphasis)
    #word#     -> shout it  (pitch up, faster, louder)
    ...        -> dramatic pause

This module converts those tags into SSML that edge-tts (Microsoft neural
voices) honors, producing audio that actually stresses the words the AI
chose to emphasize. Fallback backend: espeak-ng (offline, robotic).
"""
from __future__ import annotations

import asyncio
import base64
import logging
import os
import re
import subprocess
import tempfile

log = logging.getLogger("tts")

# Voice map: persona key -> edge-tts neural voice.
PERSONA_VOICES = {
    "maya": "en-GB-SoniaNeural",       # warm, curious young woman
    "juniper": "en-US-AriaNeural",     # energetic
    "zed": "en-US-GuyNeural",          # dry male voice
}

_DEFAULT_VOICE = "en-US-JennyNeural"

# Cache phrase -> bytes (only for plain text, since emphasis tags alter audio).
_cache: dict[tuple[str, str], bytes] = {}
_cache_lock = asyncio.Lock()


def to_ssml(text: str) -> str:
    """Convert *emphasis* / #shout# / ... tags into SSML edge-tts understands."""
    t = text
    # Shout: pitch up, slightly faster, louder
    t = re.sub(r"#([^#]+)#", r'<prosody pitch="+18%" rate="-8%" volume="+25%">\1</prosody>', t)
    # Strong emphasis on a word/phrase
    t = re.sub(r"\*([^*]+)\*", r'<emphasis level="strong">\1</emphasis>', t)
    # Dramatic pauses: '...' or ' . . . '
    t = re.sub(r"\s*\.\s*\.\s*\.\s*", ' <break time="600ms"/> ', t)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def strip_tags(text: str) -> str:
    """Remove emphasis markup entirely (for espeak fallback / subtitles)."""
    t = text
    t = t.replace("#", "")
    t = t.replace("*", "")
    t = re.sub(r"\s*\.\s*\.\s*\.\s*", " ... ", t)
    return re.sub(r"\s+", " ", t).strip()


async def _synthesize_edge(text: str, voice: str) -> bytes | None:
    try:
        import edge_tts
    except ImportError:
        return None
    try:
        comm = edge_tts.Communicate(to_ssml(text), voice, rate="-5%")
        buf = bytearray()
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                buf.extend(chunk["data"])
        if not buf:
            return None
        return bytes(buf)
    except Exception as exc:  # noqa: BLE001
        log.warning("edge-tts failed: %s", exc)
        return None


def _synthesize_espeak(text: str, voice: str = "en") -> bytes | None:
    espeak = "espeak-ng"
    if not os.system(f"command -v {espeak} >/dev/null 2>&1") == 0:
        espeak = "espeak"
    try:
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            wav_path = tmp.name
        plain = strip_tags(text)
        result = subprocess.run(
            [espeak, "-v", voice, "-s", "165", "-a", "160", "-w", wav_path, plain],
            capture_output=True, timeout=20,
        )
        if result.returncode != 0:
            return None
        with open(wav_path, "rb") as f:
            data = f.read()
        os.unlink(wav_path)
        return data if data else None
    except Exception as exc:  # noqa: BLE001
        log.warning("espeak failed: %s", exc)
        return None


async def synthesize(text: str, voice: str = _DEFAULT_VOICE) -> dict | None:
    """Return {audio: base64, mime, ssml} or None. edge-tts then espeak."""
    text = text.strip()
    if not text:
        return None

    # Cache keyed on the SSML so emphasis tags produce distinct audio.
    ssml = to_ssml(text)
    key = (ssml, voice)
    async with _cache_lock:
        cached = _cache.get(key)
    if cached is not None:
        return {"audio": base64.b64encode(cached).decode(), "mime": "audio/mpeg", "ssml": ssml}

    data = await _synthesize_edge(text, voice)
    mime = "audio/mpeg"
    if data is None:
        data = await asyncio.to_thread(_synthesize_espeak, text)
        mime = "audio/wav"
    if data is None:
        return None

    async with _cache_lock:
        _cache[key] = data
    return {"audio": base64.b64encode(data).decode(), "mime": mime, "ssml": ssml}


async def prewarm() -> None:
    if await synthesize("Hello, this is a test."):
        log.info("TTS backend ready (edge-tts/espeak)")
    else:
        log.warning("No TTS backend available!")
