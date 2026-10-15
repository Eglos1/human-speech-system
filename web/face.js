/**
 * FaceRig — a canvas digital face whose geometry is deformed by RAW MUSCLES.
 *
 * The LLM outputs muscle activations (0-100) and this rig bends the actual
 * vertices of the mouth/lips/eyes/brows accordingly:
 *   jaw, smile, pucker, brows, upperLip, lowerLip, squint
 * plus procedural blink + breathing so it feels alive.
 *
 * All rendering happens in `draw(muscles)` — one muscle dict in, one face out.
 */
class FaceRig {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.W = canvas.width;
    this.H = canvas.height;
    this.cx = this.W / 2;

    // Smoothed current muscle state (0..1), lerps toward the target each frame.
    this.current = { jaw:0, smile:0.15, pucker:0, brows:0.5, upperLip:0, lowerLip:0, squint:0, tongue:0.5, velum:0, air:0.5 };
    this.target  = { ...this.current };

    this.blinkTimer = 1.2 + Math.random() * 3;
    this.blinkAmt = 0;
    this.blinkPhase = 0;
    this.t = 0;
    this.lastMs = performance.now();

    this.loop = this.loop.bind(this);
    this.draw = this.draw.bind(this);
    requestAnimationFrame(this.loop);
  }

  setTarget(muscles) {
    // Convert incoming 0..100 values to 0..1 and store.
    const conv = (v, d) => (v == null ? d : Math.max(0, Math.min(100, v)) / 100);
    this.target = {
      jaw:      conv(muscles.jaw, this.target.jaw),
      smile:    conv(muscles.smile, this.target.smile),
      pucker:   conv(muscles.pucker, this.target.pucker),
      brows:    conv(muscles.brows, this.target.brows),
      upperLip: conv(muscles.upperLip, this.target.upperLip),
      lowerLip: conv(muscles.lowerLip, this.target.lowerLip),
      squint:   conv(muscles.squint, this.target.squint),
      tongue:   conv(muscles.tongue, this.target.tongue),
      velum:    conv(muscles.velum, this.target.velum),
      air:      conv(muscles.air, this.target.air),
    };
  }

  /** Transition to an expressive pose and hold it (used for thinking/neutral). */
  poseTo(muscles, dur = 400) {
    this.setTarget(muscles);
  }

  loop() {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastMs) / 1000);
    this.lastMs = now;
    this.t += dt;

    // Smooth muscle interpolation (fast settle = snappy but organic).
    const k = 1 - Math.pow(0.0001, dt);   // ~ 100ms blend
    for (const key of Object.keys(this.target)) {
      this.current[key] += (this.target[key] - this.current[key]) * k;
      if (Math.abs(this.current[key] - this.target[key]) < 0.002) this.current[key] = this.target[key];
    }

    // Procedural blink (occasional, fast).
    this.blinkTimer -= dt;
    if (this.blinkTimer <= 0) {
      this.blinkPhase = Math.PI;          // start blink
      this.blinkTimer = 1.5 + Math.random() * 4;
    }
    if (this.blinkPhase > 0 && this.blinkPhase < Math.PI * 2) {
      this.blinkPhase += dt * 16;         // ~400ms full blink
      this.blinkAmt = Math.sin(this.blinkPhase);
      this.blinkAmt = Math.max(0, this.blinkAmt);
    } else {
      this.blinkAmt = 0;
    }

    // Breathing: subtle head bob + shoulder rise. Loud air = deeper breathing.
    const airBoost = 1 + (this.current.air || 0) * 0.7;
    const breath = (0.5 + 0.5 * Math.sin(this.t * 2.1)) * airBoost;

    this.draw(this.current, breath, this.blinkAmt);
    requestAnimationFrame(this.loop);
  }

  // ---------------------------------------------------------------- drawing
  draw(m, breath, blinkAmt) {
    const ctx = this.ctx;
    const W = this.W, H = this.H, cx = this.cx;

    ctx.clearRect(0, 0, W, H);
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#10131d");
    sky.addColorStop(1, "#232a3d");
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    const bob = breath * 3.0;              // head bob px
    const bobX = Math.sin(this.t * 2.1) * 1.5;

    ctx.save();
    ctx.translate(bobX, bob);

    this.drawNeckAndShoulders(ctx, breath);
    this.drawHead(ctx);
    this.drawEars(ctx);
    this.drawHair(ctx);
    this.drawEyes(ctx, m, blinkAmt);
    this.drawBrows(ctx, m, breath);
    this.drawNose(ctx, breath);
    this.drawCheeks(ctx, m, breath);
    this.drawMouth(ctx, m);
    this.drawJawline(ctx);

    ctx.restore();

    // HUD-ish soft vignette
    const vg = ctx.createRadialGradient(cx, H/2, H*0.3, cx, H/2, H*0.85);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.45)");
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);
  }

  drawNeckAndShoulders(ctx, breath) {
    const cx = this.cx, H = this.H;
    const rise = breath * 6;
    // shoulders
    ctx.fillStyle = "#3d3b57";
    ctx.beginPath();
    ctx.moveTo(cx - 240, H + 20);
    ctx.quadraticCurveTo(cx - 90, H - 120 - rise, cx, H - 150 - rise);
    ctx.quadraticCurveTo(cx + 90, H - 120 - rise, cx + 240, H + 20);
    ctx.closePath();
    ctx.fill();
    // neck
    ctx.fillStyle = "#e9b487";
    ctx.fillRect(cx - 62, H - 190, 124, 190);
    // neck shading
    const shade = ctx.createLinearGradient(cx - 62, 0, cx + 62, 0);
    shade.addColorStop(0, "rgba(120,60,40,0.25)");
    shade.addColorStop(0.5, "rgba(0,0,0,0)");
    shade.addColorStop(1, "rgba(120,60,40,0.25)");
    ctx.fillStyle = shade;
    ctx.fillRect(cx - 62, H - 190, 124, 190);
  }

  drawHead(ctx) {
    const cx = this.cx;
    const baseY = 348;
    const rx = 175, ry = 205;

    const skin = ctx.createRadialGradient(cx - 40, baseY - 60, 30, cx, baseY, 210);
    skin.addColorStop(0, "#f6c896");
    skin.addColorStop(0.6, "#eeb88a");
    skin.addColorStop(1, "#d89a6d");
    ctx.fillStyle = skin;
    ctx.beginPath();
    ctx.ellipse(cx, baseY, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    // forehead sheen
    ctx.fillStyle = "rgba(255,240,220,0.18)";
    ctx.beginPath();
    ctx.ellipse(cx - 30, baseY - 110, 70, 45, -0.25, 0, Math.PI * 2);
    ctx.fill();
  }

  drawEars(ctx) {
    const cx = this.cx;
    const baseY = 348;
    ctx.fillStyle = "#e5a879";
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + dir * 176, baseY + 10, 26, 42, dir * 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(150,80,55,0.25)";
      ctx.beginPath();
      ctx.ellipse(cx + dir * 176, baseY + 12, 10, 22, dir * 0.18, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#e5a879";
    }
  }

  drawHair(ctx) {
    const cx = this.cx;
    const baseY = 348;
    ctx.fillStyle = "#4a3626";
    ctx.beginPath();
    ctx.moveTo(cx - 168, baseY - 40);
    ctx.quadraticCurveTo(cx - 176, baseY - 205, cx, baseY - 208);
    ctx.quadraticCurveTo(cx + 176, baseY - 205, cx + 168, baseY - 40);
    ctx.quadraticCurveTo(cx + 168, baseY - 90, cx + 120, baseY - 96);
    ctx.quadraticCurveTo(cx + 168, baseY - 8, cx + 150, baseY - 20);
    ctx.quadraticCurveTo(cx + 120, baseY - 70, cx + 60, baseY - 62);
    ctx.quadraticCurveTo(cx + 20, baseY - 120, cx, baseY - 118);
    ctx.quadraticCurveTo(cx - 20, baseY - 120, cx - 60, baseY - 62);
    ctx.quadraticCurveTo(cx - 120, baseY - 70, cx - 150, baseY - 20);
    ctx.quadraticCurveTo(cx - 168, baseY - 8, cx - 168, baseY - 40);
    ctx.closePath();
    ctx.fill();
    // hair shine
    ctx.fillStyle = "rgba(255,220,170,0.10)";
    ctx.beginPath();
    ctx.ellipse(cx - 20, baseY - 175, 90, 26, -0.1, 0, Math.PI * 2);
    ctx.fill();
  }

  drawEyes(ctx, m, blinkAmt) {
    const cx = this.cx;
    const baseY = 348;
    const eyeY = baseY - 40;
    const eyeX = cx;

    const squintDown = m.squint * 9;         // lids narrow
    const eyeH = 46 - squintDown;            // open eye height
    const lid = blinkAmt * eyeH * 0.96;      // blink closes from top
    const squintLid = m.squint * 10;

    for (const dir of [-1, 1]) {
      const ex = eyeX + dir * 66;
      // socket shading
      ctx.fillStyle = "rgba(140,90,70,0.18)";
      ctx.beginPath();
      ctx.ellipse(ex, eyeY + 4, 46, 26, 0, 0, Math.PI * 2);
      ctx.fill();
      // sclera
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, 44, Math.max(4, eyeH / 2), 0, 0, Math.PI * 2);
      ctx.fill();
      // iris
      const iris = ctx.createRadialGradient(ex - 3, eyeY - 3, 2, ex, eyeY, 24);
      iris.addColorStop(0, "#7fa8c9");
      iris.addColorStop(1, "#4a7ba6");
      ctx.fillStyle = iris;
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, 20, Math.max(3, Math.min(20, eyeH / 2 - 3)), 0, 0, Math.PI * 2);
      ctx.fill();
      // pupil
      ctx.fillStyle = "#1a1a22";
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, 9, Math.max(2, Math.min(9, eyeH / 2 - 6)), 0, 0, Math.PI * 2);
      ctx.fill();
      // catch light
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.beginPath();
      ctx.arc(ex - 6, eyeY - 6, 4.5, 0, Math.PI * 2);
      ctx.fill();
      // upper lid (blink + squint)
      ctx.fillStyle = "#e5a879";
      ctx.beginPath();
      ctx.ellipse(ex, eyeY, 46, 26, 0, 0, Math.PI * 2);
      ctx.save();
      ctx.clip();
      ctx.fillStyle = "#e5a879";
      ctx.fillRect(ex - 50, eyeY - 40, 100, lid + squintLid + 8);
      // lid crease
      ctx.strokeStyle = "rgba(160,90,60,0.5)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ex - 38, eyeY - 16 + lid * 0.5);
      ctx.quadraticCurveTo(ex, eyeY - 26 + lid * 0.5, ex + 38, eyeY - 16 + lid * 0.5);
      ctx.stroke();
      ctx.restore();
      // lower lid subtle line
      ctx.strokeStyle = "rgba(160,90,60,0.3)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ex - 34, eyeY + 20 - squintLid * 0.4);
      ctx.quadraticCurveTo(ex, eyeY + 24 - squintLid * 0.4, ex + 34, eyeY + 20 - squintLid * 0.4);
      ctx.stroke();
    }
  }

  drawBrows(ctx, m, breath) {
    const cx = this.cx;
    const baseY = 348;
    const by = baseY - 108 + breath * 1.2;
    // brows: 0.5 neutral, >0.5 raised (surprise), <0.5 furrowed (thinking)
    const raise = (m.brows - 0.5) * 2;      // -1..1
    const lift = raise * 16;
    const innerDrop = -Math.max(0, -raise) * 18;   // furrow pulls inner down

    ctx.lineCap = "round";
    for (const dir of [-1, 1]) {
      const x0 = cx + dir * 30;
      const x1 = cx + dir * 92;
      const y0 = by - lift * 0.7 + innerDrop * (dir === -1 ? 1 : 1);
      const y1 = by - lift - innerDrop * (dir === -1 ? 1 : 1) + (dir === 1 ? -lift*0.3 : 0);
      ctx.strokeStyle = "#4a3626";
      ctx.lineWidth = 13;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx + dir * 62, by - lift - innerDrop + 2, x1, y1);
      ctx.stroke();
      ctx.lineWidth = 6;
      ctx.strokeStyle = "#5f4734";
      ctx.beginPath();
      ctx.moveTo(x0, y0 - 1);
      ctx.quadraticCurveTo(cx + dir * 62, by - lift - innerDrop + 1, x1, y1 - 1);
      ctx.stroke();
    }
  }

  drawNose(ctx, breath) {
    const cx = this.cx;
    const baseY = 348;
    const ny = baseY + 70 + breath * 1.0;
    ctx.strokeStyle = "rgba(170,100,70,0.55)";
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    // bridge
    ctx.beginPath();
    ctx.moveTo(cx, baseY - 50);
    ctx.quadraticCurveTo(cx - 6, ny - 18, cx - 12, ny - 6);
    ctx.stroke();
    // nostrils
    for (const dir of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(cx + dir * 20, ny + 2, 11, 7, dir * 0.25, 0, Math.PI * 2);
      ctx.stroke();
    }
    // tip highlight
    ctx.fillStyle = "rgba(255,225,195,0.35)";
    ctx.beginPath();
    ctx.ellipse(cx - 4, ny - 6, 12, 8, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  drawCheeks(ctx, m, breath) {
    const cx = this.cx;
    const baseY = 348;
    const chy = baseY + 60 + breath * 2;
    const blush = 0.10 + m.smile * 0.14 + m.pucker * 0.06;
    for (const dir of [-1, 1]) {
      ctx.fillStyle = `rgba(220,120,100,${blush.toFixed(3)})`;
      ctx.beginPath();
      ctx.ellipse(cx + dir * 118, chy, 34, 20, dir * 0.25, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawJawline(ctx) {
    const cx = this.cx;
    const baseY = 348;
    ctx.strokeStyle = "rgba(150,90,65,0.18)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(cx - 140, baseY - 40);
    ctx.quadraticCurveTo(cx - 170, baseY + 70, cx - 100, baseY + 160);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx + 140, baseY - 40);
    ctx.quadraticCurveTo(cx + 170, baseY + 70, cx + 100, baseY + 160);
    ctx.stroke();
  }

  /**
   * THE MOUTH — every vertex below is a function of raw muscle values.
   * This is the digital mouth the LLM controls, muscle by muscle.
   */
  drawMouth(ctx, m) {
    const cx = this.cx;
    const my = 348 + 142;                 // mouth center y

    const smile = m.smile;
    const jaw   = m.jaw;
    const pk    = m.pucker;
    const ul    = m.upperLip;
    const ll    = m.lowerLip;
    const tongueM = m.tongue;   // 0 low-back "ah" .. 1 high-front "ee"
    const velumM   = m.velum;   // nasal port (uvula drops when open)

    // --- geometry derived directly from muscles ------------------------------
    // corners pulled up by smile, pushed slightly down as the jaw drops
    const cornerDy = -26 * smile + jaw * 16;
    // width: smile widens, pucker narrows, jaw widens a touch
    const halfW = 88 * (1 + 0.30 * smile) * (1 - 0.32 * pk) + jaw * 14;
    // vertical opening of the mouth (the jaw muscle is the main driver)
    const gap = jaw * 54;
    // upper lip edge rises with upperLip muscle; lower lip edge drops with lowerLip
    const upperEdge = my + cornerDy - gap * 0.55 - ul * 15;
    const lowerEdge = my + cornerDy + gap * 0.45 + ll * 17;
    const leftX = cx - halfW;
    const rightX = cx + halfW;

    const lipTop = "#d46a6a";
    const lipBottom = "#b3545a";
    const lipLine = "#9c3f47";

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // --- interior of the mouth (visible when jaw opens) ---------------------
    if (gap > 5) {
      const mouthHole = "#6e1f28";
      ctx.fillStyle = mouthHole;
      ctx.beginPath();
      ctx.moveTo(leftX, my + cornerDy + 2);
      ctx.quadraticCurveTo(cx, upperEdge + 4, rightX, my + cornerDy + 2);
      ctx.lineTo(rightX, my + cornerDy + gap * 0.42 + 2);
      ctx.quadraticCurveTo(cx, lowerEdge - 6, leftX, my + cornerDy + gap * 0.42 + 2);
      ctx.closePath();
      ctx.fill();

      // teeth band (upper, when the mouth is open enough)
      if (gap > 14) {
        ctx.fillStyle = "#f4f0e4";
        ctx.beginPath();
        ctx.moveTo(leftX + 8, upperEdge + 4);
        ctx.quadraticCurveTo(cx, upperEdge + 2, rightX - 8, upperEdge + 4);
        ctx.lineTo(rightX - 8, upperEdge + 16);
        ctx.quadraticCurveTo(cx, upperEdge + 18, leftX + 8, upperEdge + 16);
        ctx.closePath();
        ctx.fill();
        // teeth separation lines
        ctx.strokeStyle = "rgba(160,150,130,0.6)";
        ctx.lineWidth = 1;
        for (let i = -2; i <= 2; i++) {
          if (i === 0) continue;
          const tx = cx + i * (halfW - 10) / 3;
          ctx.beginPath();
          ctx.moveTo(tx, upperEdge + 4);
          ctx.lineTo(tx, upperEdge + 15);
          ctx.stroke();
        }
      }

      // uvula / soft palate (velum muscle opens the nasal port)
      if (velumM > 0.12) {
        const uvY = upperEdge + 6 + velumM * 10;
        ctx.fillStyle = `rgba(160,60,70,${(0.55 + velumM * 0.35).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(cx, uvY, 5 + velumM * 3, 9 + velumM * 10, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "rgba(255,200,200,0.25)";
        ctx.beginPath();
        ctx.ellipse(cx - 1, uvY - 2, 2, 3, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // tongue (moves with the LLM's tongue muscle: 0 low-back, 1 high-front)
      ctx.fillStyle = "#c95a62";
      const tTipX = cx + (tongueM - 0.5) * 44;          // rises toward the front
      const tTipY = lowerEdge - 6 - tongueM * 12 - jaw * 2;
      const tRootY = lowerEdge - 4;
      ctx.beginPath();
      ctx.moveTo(leftX + 14, tRootY - 8);
      ctx.quadraticCurveTo(cx - 10, tRootY - 6, cx, tRootY - 10);
      ctx.quadraticCurveTo(tTipX - (tTipX - cx) * 0.4, tTipY + 6, tTipX, tTipY);
      ctx.quadraticCurveTo(cx, tTipY - 8, rightX - 14, tRootY - 8);
      ctx.quadraticCurveTo(cx, tRootY + 2, leftX + 14, tRootY - 8);
      ctx.closePath();
      ctx.fill();
      // tongue tip highlight
      ctx.fillStyle = "rgba(255,190,195,0.45)";
      ctx.beginPath();
      ctx.ellipse(tTipX, tTipY - 1, 7, 4, -0.25, 0, Math.PI * 2);
      ctx.fill();
    }

    // --- upper lip ----------------------------------------------------------
    const upY = upperEdge;
    const cupidDip = 10 - jaw * 4;          // cupid's bow flattens as jaw drops
    const upperThick = 15 + ll * 4;

    const gradTop = ctx.createLinearGradient(0, upY - upperThick, 0, upY);
    gradTop.addColorStop(0, "#e58a86");
    gradTop.addColorStop(1, lipLine);
    ctx.fillStyle = gradTop;

    ctx.beginPath();
    ctx.moveTo(leftX, my + cornerDy + 2);
    // left half with cupid's bow
    ctx.bezierCurveTo(
      leftX + halfW * 0.30, upY - upperThick - 4,
      leftX + halfW * 0.55, upY - cupidDip * 1.6,
      cx, upY - cupidDip
    );
    // right half
    ctx.bezierCurveTo(
      cx + halfW * 0.45, upY - cupidDip * 1.6,
      rightX - halfW * 0.30, upY - upperThick - 4,
      rightX, my + cornerDy + 2
    );
    // return along bottom edge of the upper lip
    ctx.quadraticCurveTo(cx, upY + 3, leftX, my + cornerDy + 2);
    ctx.closePath();
    ctx.fill();

    // upper lip line (the seam)
    ctx.strokeStyle = lipLine;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(leftX, my + cornerDy + 2);
    ctx.quadraticCurveTo(cx, upY + 4, rightX, my + cornerDy + 2);
    ctx.stroke();

    // --- lower lip ----------------------------------------------------------
    if (gap <= 5) {
      const loY = my + cornerDy + 6;
      const lowerThick = 17 + smile * 5;
      const gradBot = ctx.createLinearGradient(0, loY, 0, loY + lowerThick);
      gradBot.addColorStop(0, lipLine);
      gradBot.addColorStop(1, "#a3454d");
      ctx.fillStyle = gradBot;
      ctx.beginPath();
      ctx.moveTo(leftX, loY);
      ctx.quadraticCurveTo(leftX + halfW * 0.2, loY - 3, cx, loY - 1);
      ctx.quadraticCurveTo(rightX - halfW * 0.2, loY - 3, rightX, loY);
      ctx.quadraticCurveTo(cx + halfW * 0.15, loY + lowerThick + 8, cx, loY + lowerThick + 6);
      ctx.quadraticCurveTo(cx - halfW * 0.15, loY + lowerThick + 8, leftX, loY);
      ctx.closePath();
      ctx.fill();
      // lower lip highlight
      ctx.fillStyle = "rgba(255,220,215,0.35)";
      ctx.beginPath();
      ctx.ellipse(cx, loY + 4, halfW * 0.42, 5, 0, 0, Math.PI);
      ctx.fill();
    } else {
      // open mouth: lower lip is the chin-side band under lowerEdge
      const lowerThick = 15 + ll * 8;
      const gradBot = ctx.createLinearGradient(0, lowerEdge, 0, lowerEdge + lowerThick);
      gradBot.addColorStop(0, "#9c3f47");
      gradBot.addColorStop(1, "#a3454d");
      ctx.fillStyle = gradBot;
      ctx.beginPath();
      ctx.moveTo(leftX, lowerEdge - 1);
      ctx.quadraticCurveTo(cx, lowerEdge - 5, rightX, lowerEdge - 1);
      ctx.quadraticCurveTo(rightX + halfW * 0.10, lowerEdge + lowerThick, cx, lowerEdge + lowerThick + 4);
      ctx.quadraticCurveTo(cx - halfW * 0.10, lowerEdge + lowerThick, leftX, lowerEdge - 1);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(255,220,215,0.30)";
      ctx.beginPath();
      ctx.ellipse(cx, lowerEdge + 5, halfW * 0.4, 4, 0, 0, Math.PI);
      ctx.fill();
    }

    // --- pucker shading: lips pushed forward cast a shadow ring -------------
    if (pk > 0.05) {
      ctx.strokeStyle = `rgba(90,40,45,${(pk * 0.5).toFixed(3)})`;
      ctx.lineWidth = 8 + pk * 6;
      ctx.beginPath();
      ctx.ellipse(cx, my + cornerDy + 6 + jaw * 10, halfW * 0.98, 26 + pk * 8, 0, 0, Math.PI * 2);
      ctx.stroke();
      // pulled-together lines on the pursed lips
      ctx.strokeStyle = `rgba(120,60,60,${(pk * 0.8).toFixed(3)})`;
      ctx.lineWidth = 2;
      const creases = 3 + Math.round(pk * 3);
      for (let i = 0; i < creases; i++) {
        const fx = cx - halfW * 0.7 + (i * halfW * 1.4) / (creases - 1);
        ctx.beginPath();
        ctx.moveTo(fx, my + cornerDy - 3 + pk * 4);
        ctx.lineTo(fx + 3, my + cornerDy + 5 - pk * 4);
        ctx.stroke();
      }
    }

    // --- smile dimples ------------------------------------------------------
    if (smile > 0.08) {
      ctx.fillStyle = `rgba(150,80,60,${(smile * 0.5).toFixed(3)})`;
      for (const dir of [-1, 1]) {
        ctx.beginPath();
        ctx.ellipse(cx + dir * (halfW + 16), my + cornerDy + 4, 7, 5, dir * 0.3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

if (typeof module !== "undefined") module.exports = FaceRig;
