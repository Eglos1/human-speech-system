"""
Raw facial-muscle parser.

The 1B LLM emits one line per animation frame in the format:

    jaw smile pucker brows upper lower squint | spoken words

Values are 0-100 (100 = max muscle contraction). Missing fields carry over
the previous value, which makes the model's output tolerant to sloppiness.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# The muscle registers the LLM can control. Order matters (matches prompt).
# First 7 are face; last 6 are the THROAT / vocal apparatus.
MUSCLE_ORDER = [
    "jaw",      # masseter / jaw opener          (jaw drops)
    "smile",    # zygomaticus major              (corners pulled up-out)
    "pucker",   # orbicularis oris               (lips forward / purse)
    "brows",    # frontalis + corrugator         (raise >50, furrow <50)
    "upperLip", # levator labii superioris       (snarl / lip raise)
    "lowerLip", # depressor labii inferioris     (lower lip drop)
    "squint",   # orbicularis oculi              (narrowing eyes)
    # --- throat / voice: the physical speech apparatus ---
    "air",      # lungs: subglottal airflow      (0 silent, 50 speech, 100 shout)
    "tension",  # vocal folds: stretch -> pitch   (0 low/fry, 50 neutral, 100 high)
    "adduction",# vocal fold closure              (0 whisper/breathy, 100 crisp voiced)
    "velum",    # velar port -> nasal coupling    (0 oral, 100 nasal like m/n/ng)
    "fry",      # vocal fry / creakiness          (0 clean, 100 creaky)
    "tongue",   # tongue body position            (0 low-back 'ah', 50 mid, 100 high-front 'ee')
]

# Extra muscles the front-end can inject procedurally (blinks, breathing).
EXTRA_MUSCLES = ["blink", "breath"]


@dataclass
class MuscleFrame:
    """One animation frame: a snapshot of every muscle + the words spoken."""

    muscles: dict = field(default_factory=dict)   # name -> 0..100
    words: str = ""                               # spoken text for this frame
    raw_line: str = ""                            # original LLM output (debug)

    def as_dict(self) -> dict:
        return {"muscles": self.muscles, "words": self.words}


def empty_muscles() -> dict:
    return {name: 0 for name in MUSCLE_ORDER + EXTRA_MUSCLES}


# Muscle-name aliases the LLM might use instead of the canonical names.
_ALIASES = {
    "jaw": "jaw", "jaws": "jaw", "j": "jaw", "jawopen": "jaw", "jaw_open": "jaw",
    "smile": "smile", "smiles": "smile", "sm": "smile", "zyg": "smile",
    "pucker": "pucker", "pk": "pucker", "pursed": "pucker", "pout": "pucker",
    "brows": "brows", "brow": "brows", "br": "brows", "eyebrow": "brows", "eyebrows": "brows",
    "upperlip": "upperLip", "upper": "upperLip", "ul": "upperLip", "upper_lip": "upperLip",
    "lowerlip": "lowerLip", "lower": "lowerLip", "ll": "lowerLip", "lower_lip": "lowerLip",
    "squint": "squint", "sq": "squint", "narrow": "squint",
    # throat / voice
    "air": "air", "flow": "air", "airflow": "air", "breath": "air", "volume": "air", "loudness": "air",
    "tension": "tension", "pitch": "tension", "f0": "tension", "vocal": "tension",
    "adduction": "adduction", "adduct": "adduction", "voiced": "adduction", "voicing": "adduction", "breathy": "adduction",
    "velum": "velum", "nasal": "velum", "nasality": "velum", "velar": "velum",
    "fry": "fry", "creak": "fry", "creaky": "fry", "vocal_fry": "fry",
    "tongue": "tongue", "tg": "tongue", "tong": "tongue", "tonguebody": "tongue",
}


def _clamp(v: float) -> float:
    return max(0.0, min(100.0, v))


# Words/phrases that mark text as a STAGE DIRECTION (describing the face)
# rather than dialogue to be spoken. A 1B model loves writing these.
_STAGE_DIRECTION_TOKENS = {
    "jaw", "jaws", "mouth", "lips", "lip", "smile", "smiles", "smiling",
    "brow", "brows", "eyebrow", "eyebrows", "eye", "eyes", "face", "facial",
    "pucker", "puckers", "pursed", "squint", "squints", "narrow", "narrows",
    "tongue", "teeth", "cheek", "cheeks", "muscle", "muscles", "muscular",
    "widen", "widens", "winking", "wink", "blink", "blinks", "frown",
    "frowns", "furrow", "furrowed", "relax", "relaxing", "slightly",
    "gesture", "gestures", "expression", "expression:", "frame", "frames",
    "stage", "directions", "direction", "words", "words:", "to say",
    "press", "pressing", "together", "tightly", "forward", "protrude",
    "protrudes", "open", "opening", "closed", "shut", "gently", "softly",
    "slowly", "quickly", "scrunch", "scrunching", "raised", "lowered",
    "drops", "dropped", "lift", "lifts", "lifting",
}

_STAGE_DIRECTION_PREFIXES = (
    "jaw ", "jaws ", "mouth ", "lips ", "lip ", "smile", "brow", "brows",
    "eyebrow", "eyes ", "eye ", "face ", "facial", "pucker", "pursed",
    "squint", "narrow", "tongue", "teeth", "cheek", "muscle", "muscular",
    "widen", "wink", "blink", "frown", "furrow", "relax", "slightly",
    "gesture", "expression", "stage", "frames", "words",
)


def _looks_like_stage_direction(text: str) -> bool:
    """Heuristic: is this text a stage direction instead of spoken dialogue?"""
    t = text.strip().lower()
    if not t:
        return False
    # starts with a direction keyword?
    for prefix in _STAGE_DIRECTION_PREFIXES:
        if t.startswith(prefix):
            return True
    # is it mostly "mouthy" words? (e.g. "lips press together")
    words = re.findall(r"[a-z']+", t)
    if not words:
        return False
    hits = sum(1 for w in words if w in _STAGE_DIRECTION_TOKENS)
    return hits >= 2 and hits >= len(words) * 0.5


def parse_line(line: str, prev: dict | None = None) -> MuscleFrame | None:
    """Parse one raw LLM line into a MuscleFrame.

    The 1B model is *very* loose. We accept muscle pairs anywhere in the line
    (before or after the pipe), bare positional numbers, or labeled numbers,
    then whatever non-muscle text remains is treated as the spoken words.
    """
    raw = line.strip()
    if not raw:
        return None

    muscles = prev.copy() if prev else empty_muscles()
    work = raw

    # --- 1) Named pairs: jaw=30 smile=70 (find EVERYWHERE, both sides of |)
    pair_re = re.compile(
        r"\b(jaws?|j|jaw_open|smiles?|sm|zyg|puckers?|pk|pursed|pout|brows?|br|eyebrows?|"
        r"upper_?lips?|upper|ul|lower_?lips?|lower|ll|squints?|sq|narrow(?:s)?|"
        r"air|flow|airflow|volume|loudness|tension|pitch|f0|adduct(?:ion)?|voic(?:ed|ing)|"
        r"breathy|velum|nasal(?:ity)?|velar|fry|creak(?:y)?|tongue|tg|tonguebody)"
        r"\s*=\s*(-?\d+(?:\.\d+)?)",
        flags=re.IGNORECASE,
    )
    matches = pair_re.findall(work)
    for raw_name, raw_val in matches:
        name = _ALIASES.get(raw_name.lower())
        if name is None:
            continue
        try:
            muscles[name] = _clamp(float(raw_val))
        except ValueError:
            pass

    # Remove every "name=value" token from the text so it can't become "words".
    work = pair_re.sub("", work)

    # --- 2) Bare positional numbers (only when no named pairs existed)
    if not matches:
        numbers = re.findall(r"-?\d+(?:\.\d+)?", work)
        for i, name in enumerate(MUSCLE_ORDER):
            if i < len(numbers):
                muscles[name] = _clamp(float(numbers[i]))
        # remove the bare numbers too
        work = re.sub(r"-?\d+(?:\.\d+)?", "", work)

    # --- 3) What's left is the spoken words (plus junk markers).
    words = work
    for token in ("|", ":", ";", '"', "'", "words to say", "words", "say"):
        words = words.replace(token, " ")
    words = re.sub(r"\s+", " ", words).strip()
    words = words.strip(" -_")

    # Filter out stage directions (face descriptions) — not dialogue.
    if words and _looks_like_stage_direction(words):
        words = ""

    # Filter out echoes of the prompt scaffolding (multi-turn loops, the
    # "Human says: / reply lines:" boilerplate the 1B model parrots back).
    if words and re.search(r"\b(human says?|human'?s|reply lines?)\b", words, re.IGNORECASE):
        words = ""

    has_any_value = any(muscles[k] != 0 for k in MUSCLE_ORDER)
    if not has_any_value and not words:
        return None

    frame = MuscleFrame(muscles=muscles, words=words, raw_line=line)
    return frame


def parse_stream(full_text: str) -> list[MuscleFrame]:
    """Parse a complete (non-streaming) response into a list of frames."""
    frames: list[MuscleFrame] = []
    prev: dict | None = None
    for line in full_text.splitlines():
        frame = parse_line(line, prev)
        if frame is not None:
            frames.append(frame)
            prev = frame.muscles
    return frames


def muscles_to_short(muscles: dict) -> dict:
    """Convert muscle dict to short JSON-safe form for the front-end."""
    return {k: round(float(v), 1) for k, v in muscles.items()}
