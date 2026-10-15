/**
 * App: wires the WebSocket muscle stream to the FaceRig AND to the
 * in-browser ThroatEngine (a full articulatory speech synthesizer).
 *
 * Incoming frames carry { muscles, words }. We drive the face with the muscle
 * values and speak the words through the digital throat — the same 13 muscles
 * (air, tension, adduction, velum, fry, tongue + 7 face) shape the sound.
 *
 * Frames are queued so the LLM can stream while the previous phrase is still
 * being spoken. The audio runs on a Web Audio callback; the face timeline is
 * the single consumer of the frame queue, so they stay in rough sync.
 */
(() => {
  const face = new FaceRig(document.getElementById("face"));
  const subtitleEl = document.getElementById("subtitle");
  const statusEl = document.getElementById("status");
  const logEl = document.getElementById("log");
  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const sendBtn = document.getElementById("sendBtn");
  const ttsToggle = document.getElementById("ttsToggle");
  const personasEl = document.getElementById("personas");

  let ws = null;
  let currentPersona = "maya";
  let thinkTimer = null;
  const frameQueue = [];

  // ------------------------------------------------------- throat audio setup
  let audioCtx = null;
  let engine = null;
  let audioNode = null;

  /** Create/resume the audio graph (must run inside a user gesture). */
  function ensureAudio() {
    if (audioCtx) {
      if (audioCtx.state === "suspended") audioCtx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || typeof ThroatEngine !== "function") return;
    audioCtx = new AC();
    engine = new ThroatEngine(audioCtx.sampleRate);
    audioNode = audioCtx.createScriptProcessor(4096, 0, 1);
    audioNode.onaudioprocess = onAudio;
    audioNode.connect(audioCtx.destination);
    if (audioCtx.state === "suspended") audioCtx.resume();
  }

  /** Render one output chunk. Silence when muted or when nothing to say. */
  function onAudio(e) {
    const out = e.outputBuffer.getChannelData(0);
    if (!engine || !ttsToggle.checked || engine.phoneQueue.length === 0) {
      out.fill(0);
      return;
    }
    engine.render(out);
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // --------------------------------------------------------------- frame queue
  /** WS frames carry muscles on a 0-100 scale; the throat engine expects 0-1. */
  function toEngineMuscles(m) {
    const out = {};
    if (!m) return out;
    for (const k in m) out[k] = (m[k] || 0) / 100;
    return out;
  }

  /** Hold a muscle pose while its words are spoken by the throat, then relax. */
  async function playFrame(frame) {
    face.setTarget(frame.muscles);
    if (engine) engine.setMuscles(toEngineMuscles(frame.muscles));

    if (frame.words) {
      subtitleEl.textContent = frame.words;
      const holdMs = Math.max(250, Math.min(9000, 90 + frame.words.length * 65));
      if (engine) engine.speak(frame.words, holdMs / 1000);
      await sleep(holdMs);
    } else {
      if (engine) engine.stop();
      await sleep(120);
    }
    // ease toward a neutral mouth between phrases
    face.poseTo({ jaw: 0, smile: 0.1, pucker: 0, brows: 0.5, upperLip: 0, lowerLip: 0, squint: 0 }, 250);
  }

  async function drainQueue() {
    while (frameQueue.length) {
      const frame = frameQueue.shift();
      await playFrame(frame);
    }
    subtitleEl.textContent = "—";
    face.poseTo({ jaw: 0, smile: 0.2, pucker: 0, brows: 0.5, upperLip: 0, lowerLip: 0, squint: 0 }, 400);
  }

  // -------------------------------------------------------------- websocket
  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => setStatus("connected", "ok");
    ws.onclose = () => { setStatus("disconnected — retrying…", "warn"); setTimeout(connect, 1500); };
    ws.onerror = () => setStatus("connection error", "warn");

    ws.onmessage = ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      switch (msg.type) {
        case "hello":
          currentPersona = msg.persona;
          renderPersonas(msg.personas);
          setStatus("ready", "ok");
          break;

        case "thinking":
          if (msg.on) {
            subtitleEl.textContent = "…";
            // thoughtful micro-motion: eyes drift, brows knit, lips part slightly
            thinkTimer = setInterval(() => {
              face.poseTo({
                jaw: 0.05, smile: 0.05, pucker: 0.15,
                brows: 0.38, upperLip: 0.02, lowerLip: 0.05,
                squint: 0.45 + Math.random() * 0.2,
              }, 300);
            }, 350);
          } else {
            clearInterval(thinkTimer);
          }
          break;

        case "frame":
          if (thinkTimer) { clearInterval(thinkTimer); thinkTimer = null; }
          frameQueue.push(msg);
          drainQueue();
          break;

        case "speech_end":
          // nothing extra; the queue drain finishes naturally
          break;

        case "persona_changed":
          if (msg.ok) currentPersona = msg.current;
          break;

        case "error":
          addLog(`⚠ ${msg.msg}`, "error");
          break;

        case "info":
          addLog(msg.msg, "info");
          break;
      }
    };
  }

  function send(line) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ensureAudio(); // user gesture: safe to unlock the audio graph
    addLog(`You: ${line}`, "user");
    ws.send(JSON.stringify({ type: "speak", line }));
  }

  // ------------------------------------------------------------------- UI
  function setStatus(text, cls) {
    statusEl.textContent = text;
    statusEl.className = `status ${cls}`;
  }

  function addLog(text, cls) {
    const div = document.createElement("div");
    div.className = `log-line ${cls}`;
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderPersonas(list) {
    personasEl.innerHTML = "";
    for (const key of list) {
      const btn = document.createElement("button");
      btn.className = "persona" + (key === currentPersona ? " active" : "");
      btn.textContent = key[0].toUpperCase() + key.slice(1);
      btn.onclick = () => {
        ensureAudio();
        ws.send(JSON.stringify({ type: "set_persona", key }));
        currentPersona = key;
        renderPersonas(list);
      };
      personasEl.appendChild(btn);
    }
  }

  chatForm.addEventListener("submit", e => {
    e.preventDefault();
    const line = chatInput.value.trim();
    if (!line) return;
    chatInput.value = "";
    send(line);
  });

  document.querySelectorAll(".suggestions button").forEach(b => {
    b.addEventListener("click", () => send(b.dataset.line));
  });

  connect();
})();
