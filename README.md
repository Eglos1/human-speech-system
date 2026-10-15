# 1B Human Speech System

An entire human-speech pipeline where a **1B parameter LLM** (`llama3.2:1b`,
running locally in Ollama) doesn't just decide *what* a character says — it
directly controls **every raw muscle in the face and throat**, and those same
muscles drive a **full articulatory speech synthesizer** (a digital recreation
of lungs → vocal folds → vocal tract → lips) that produces the actual sound.

The LLM streams animation frames like:

```
jaw=35 smile=55 pucker=5 brows=60 upperLip=10 lowerLip=5 squint=30 air=60 tension=60 adduction=80 velum=5 fry=0 tongue=50 | *Oh* hey!
```

Each number is a raw muscle activation (0–100). The face rig deforms its
geometry from them, and the **ThroatEngine** turns the throat channels
(`air`, `tension`, `adduction`, `velum`, `fry`, `tongue`) plus the words into
synthesized speech in the browser — no external TTS needed.

---

## Architecture

```
human-speech-system/
├── run.py                 # entry point: starts server, opens browser
├── config.yaml            # model, port, persona, muscle map
├── requirements.txt
├── preview_expressions.png
├── brain/
│   ├── llm.py             # streaming Ollama client (token-by-token)
│   ├── parser.py          # raw LLM lines -> MuscleFrame objects
│   │                      #   (tolerant of sloppy 1B-model formatting,
│   │                      #    filters stage directions + prompt echoes)
│   ├── persona.py         # characters + short format-forcing prompt block
│   │                      #   (tested: short inline prompts with ONE example
│   │                      #    make the 1B model emit 13-muscle frames)
│   └── conductor.py       # prompt -> stream -> parse -> broadcast to WS
├── server/
│   └── app.py             # FastAPI: static web app + /ws WebSocket
└── web/
    ├── index.html         # UI: face, chat, persona picker, throat toggle
    ├── face.js            # FaceRig: canvas face deformed by raw muscles
    ├── throat.js          # ThroatEngine: articulatory speech synthesizer
    │                      #   (LF glottal source + 44-cell Kelly-Lochbaum
    │                      #    waveguide + nasal tract + phonemizer;
    │                      #    adapted from Pink Trombone, MIT)
    ├── app.js             # WS client, frame queue, Web Audio playback
    └── style.css
```

### The muscle rig

Every muscle is an independent channel the LLM drives from 0–100:

| Muscle     | What it does                                     |
|------------|--------------------------------------------------|
| `jaw`      | how far the mouth opens                          |
| `smile`    | corners pulled up-and-out (zygomaticus)          |
| `pucker`   | lips pushed forward / pursed (orbicularis)       |
| `brows`    | 50 neutral, >50 raised, <50 furrowed             |
| `upperLip` | upper lip lifted (snarl / consonants)            |
| `lowerLip` | lower lip dropped (sad / vowels / thinking)      |
| `squint`   | eyes narrowed (0 wide … 100 squeezed)            |
| `air`      | lung airflow → loudness (0 silent, 50 speech)    |
| `tension`  | vocal-fold stretch → pitch (55–270 Hz)           |
| `adduction`| vocal-fold closure → voicing (0 whisper, 100 crisp) |
| `velum`    | nasal port → nasality (m/n/ng)                   |
| `fry`      | vocal fry / creak in the folds                   |
| `tongue`   | tongue body position (0 low-back "ah", 100 high-front "ee") |

### The throat (web/throat.js)

A Pink-Trombone-style articulatory synthesizer:

- **Glottis**: LF (Liljencrants-Fant) glottal-pulse waveform. `tension` sets
  f0, `adduction` sets tenseness/breathiness, `air` sets intensity,
  `fry` adds creak + jitter.
- **Tract**: 44-cell Kelly–Lochbaum digital waveguide (run at 2× sample rate)
  plus a 28-cell nasal tract. Tongue/jaw/lips/velum change the tube's
  diameters, which shapes the formants.
- **Articulator**: maps each muscle + the current phoneme onto tract
  diameters, with plosive transients and fricative turbulence.
- **Phonemizer**: turns the LLM's words into a phone stream (`ee`, `sh`,
  `p`, …) so the vowels/consonants genuinely differ.

The LLM's own muscle values *are* the articulation: whisper at low
`adduction`, shout at high `air`, nasal "mm-hmm" at high `velum`.

### Why the parser is the heart of it

A 1B model is *not* great at strict JSON, so `parser.py` accepts any of:

```
jaw=30 smile=70 ... | words
30 70 5 40 10 5 20 ... | words
| jaw=30 smile=70 ... | words    (model reverses the pipe sometimes)
jaw=30 smile=70 ...               (model forgets the pipe; words on next line)
```

and treats leftover text as the spoken words while **dropping stage
directions** ("lips press together tightly") and **prompt echoes**
("Human says: …", "Your reply lines") so those never reach the synthesizer.

### Getting the 1B model to cooperate

Tested against `llama3.2:1b` — the trick that works:

- Keep the prompt **short**: persona line + one format line + rules + a
  single example. Long rule lists, muscle legends, and separate "system"
  messages make it drift into prose or echo the format verbatim.
- Inline the whole thing in the prompt (not as an Ollama `system` message).
- Low temperature (0.4) + a `\nHuman` stop token keeps it from looping.

---

## Quick start

Prereqs: Python 3.10+, [Ollama](https://ollama.com) running with the model pulled:

```bash
ollama pull llama3.2:1b
```

Run the system:

```bash
cd human-speech-system
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python3 run.py
```

Open `http://localhost:8000`, type something, and watch the 1B model think,
then speak — moving the mouth muscle by muscle, with the sound synthesized
by the digital throat it controls.

Options: `--port 9000`, `--no-browser`.

---

## How it works, end to end

1. You type a line → WebSocket sends it to the conductor.
2. Conductor builds the persona prompt block inline with the dialogue.
3. `llama3.2:1b` streams a response token-by-token.
4. Every complete line is parsed into a `MuscleFrame` (13 muscles + words).
5. Frames are pushed to the browser over WebSocket as they arrive — so the
   face animates *while the model is still generating*.
6. The browser queues frames; for each frame it sets the face pose AND feeds
   the ThroatEngine the muscles + words; a Web Audio callback renders the
   synthesized speech in real time.

## Changing the character

Personas live in `brain/persona.py`. Each needs a `short` description (used in
the prompt) + few-shot examples that teach the model *how that character
animates*. Add a new one and it appears in the UI automatically.

## Ideas to extend

- **Emotion memory**: track a mood state across turns and inject it into the
  prompt so expressions evolve during a conversation.
- **Multiple faces**: one conductor per character, each with its own rig.
- **Better phonemizer**: a proper grapheme→phoneme table (e.g. `espeak-ng`
  data) for cleaner consonants.
- **Viseme blend**: mix LLM jaw with a phoneme-driven jaw curve for tighter
  lip sync.


## Builds

Prebuilt Windows / Linux / macOS artifacts are produced by the GitHub Actions workflow in `.github/workflows/build.yml` on every tag.

## License

MIT
