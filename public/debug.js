const showFatal = (msg) => {
  document.body.innerHTML = ""
  document.body.style.margin = "0"
  document.body.style.background = "#fff"
  document.body.style.color = "#e6007e"
  document.body.style.fontFamily = "\"GeistRegular\", system-ui, -apple-system, Arial"
  const pre = document.createElement("pre")
  pre.style.whiteSpace = "pre-wrap"
  pre.style.padding = "16px"
  pre.textContent = msg
  document.body.appendChild(pre)
}

window.addEventListener("error", (e) => {
  showFatal(`JS error\n\n${e.message}\n\n${e.filename}:${e.lineno}:${e.colno}`)
})

window.addEventListener("unhandledrejection", (e) => {
  showFatal(`Promise rejection\n\n${e.reason}`)
})

const app = document.getElementById("app") || (() => {
  const d = document.createElement("div")
  d.id = "app"
  document.body.appendChild(d)
  return d
})()

document.body.style.margin = "0"
document.body.style.background = "#fff"
document.body.style.color = "#e6007e"
document.body.style.fontFamily = "\"GeistRegular\", system-ui, -apple-system, Arial"

app.style.padding = "16px"

const feed = document.createElement("pre")
feed.style.whiteSpace = "pre-wrap"
feed.style.overflowWrap = "anywhere"
feed.style.lineHeight = "1.35"
feed.style.fontFamily = "\"GeistRegular\", system-ui, -apple-system, Arial"
feed.textContent = ""
app.appendChild(feed)

const writeQueue = []
let writing = false
let reloadWhenIdle = false

const maybeReload = () => {
  if (reloadWhenIdle && !writing && writeQueue.length === 0) {
    setTimeout(() => location.reload(), 400)
  }
}

const flushQueue = () => {
  if (writing || !writeQueue.length) return
  writing = true
  const next = writeQueue.shift() || ""
  let i = 0
  const charsPerFrame = 1.5
  let carry = 0
  const tick = () => {
    if (i < next.length) {
      carry += charsPerFrame
      const step = Math.floor(carry)
      if (step > 0) {
        feed.textContent += next.slice(i, i + step)
        i += step
        carry -= step
      }
      feed.scrollTop = feed.scrollHeight
      window.scrollTo(0, document.body.scrollHeight)
      window.requestAnimationFrame(tick)
      return
    }
    writing = false
    flushQueue()
    maybeReload()
  }
  tick()
}

const line = (obj) => {
  const t = new Date().toISOString().slice(11, 23)
  const msg = `[${t}] ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`
  writeQueue.push(msg)
  flushQueue()
}

const lineInstant = (obj) => {
  const t = new Date().toISOString().slice(11, 23)
  const msg = `[${t}] ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n`
  feed.textContent += msg
  feed.scrollTop = feed.scrollHeight
  window.scrollTo(0, document.body.scrollHeight)
}

line("waiting for events on /api/stream")

const GEN_DURATION_MS = 15000;
let fakeTimer = null;
let fakeStart = 0;
let fakeRunId = null;
let fakeStep = 0;
let currentPrompt = "";
let promptWords = [];

function stopFakeStream(){
  if (fakeTimer){
    clearInterval(fakeTimer);
    fakeTimer = null;
  }
  fakeStart = 0;
  fakeRunId = null;
  fakeStep = 0;
  currentPrompt = "";
  promptWords = [];
}

function randHex(len){
  const chars = "abcdef0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function randInt(a, b){
  return Math.floor(Math.random() * (b - a + 1)) + a;
}

function setPrompt(p){
  if (!p || typeof p !== "string") return;
  const cleaned = p.replace(/\s+/g, " ").trim();
  if (!cleaned) return;
  currentPrompt = cleaned;
  promptWords = cleaned.split(" ").filter(Boolean);
}

function promptFragment(){
  if (!promptWords.length) return "";
  const start = Math.max(0, Math.floor(Math.random() * promptWords.length) - 3);
  const end = Math.min(promptWords.length, start + randInt(3, 9));
  return promptWords.slice(start, end).join(" ");
}

function extractPrompt(data){
  if (!data || typeof data !== "object") return "";
  if (typeof data.prompt === "string") return data.prompt;
  if (data.input && typeof data.input.prompt === "string") return data.input.prompt;
  if (data.data && typeof data.data.prompt === "string") return data.data.prompt;
  return "";
}

function buildFakeLine(step, pct){
  const stages = ["compile", "link", "sample", "warp", "denoise", "balance", "bake", "compose", "resolve", "finalize"];
  const stage = stages[step % stages.length];
  const chunk = randInt(1, 64);
  const total = 64;
  const kb = randInt(64, 512);
  const kernel = randHex(8);
  const seed = randHex(6);
  const frag = promptFragment();
  if (frag && Math.random() < 0.22) {
    return `[${pct}%] prompt: "${frag}"`;
  }

  const templates = [
    `[${pct}%] ${stage} shader stage ${randInt(1, 5)}`,
    `[${pct}%] kernel patch ${kernel} applied`,
    `[${pct}%] decode tiles ${chunk}/${total}`,
    `[${pct}%] fuse frames ${randInt(1, 9)}/${randInt(10, 18)}`,
    `[${pct}%] write buffer 0x${randHex(6)} (${kb}kb)`,
    `[${pct}%] stabilize exposure`,
    `[${pct}%] align features`,
    `[${pct}%] seed 0x${seed} → jitter ${randInt(1, 9)}`,
    `> const seed = 0x${seed};`,
    `> for (let i = 0; i < ${randInt(3, 9)}; i++) { noise[i] = mix(noise[i], latent[i]); }`,
    currentPrompt ? `> prompt += " ${promptFragment()}";` : `[${pct}%] resolve attention map`
  ];
  return templates[Math.floor(Math.random() * templates.length)];
}

function startFakeStream(runId){
  stopFakeStream();
  fakeRunId = runId || String(Date.now());
  fakeStart = performance.now();
  fakeStep = 0;
  fakeTimer = setInterval(() => {
    const elapsed = performance.now() - fakeStart;
    const pct = Math.min(99, Math.floor((elapsed / GEN_DURATION_MS) * 100));
    if (elapsed >= GEN_DURATION_MS) {
      stopFakeStream();
      return;
    }
    line(buildFakeLine(fakeStep++, pct));
  }, 250);
}

const es = new EventSource("/api/stream")
es.onmessage = (e) => {
  try {
    const data = JSON.parse(e.data)
    if (data?.type && String(data.type).startsWith("control_")) return
    const prompt = extractPrompt(data);
    if (prompt) setPrompt(prompt);
    if (data && (data.type === "run_done" || data.type === "asset_written")) {
      lineInstant(data)
      if (data.type === "run_done") reloadWhenIdle = true
    } else {
      line(data)
      if (data && data.type === "run_error") reloadWhenIdle = true
    }

    if (data && data.type === "run_start") {
      startFakeStream(data.runId);
    }
    if (data && (data.type === "run_done" || data.type === "run_error")) {
      stopFakeStream();
    }
  } catch {
    line(e.data)
  }
}
es.onerror = () => line("stream error")

initOverlay();

async function initOverlay() {
  const overlayMount = document.getElementById("overlayMount");
  if (!overlayMount) return;

  const url = "./svg_debug/debug_overlay.svg";

  let svgText;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`fetch failed: ${r.status}`);
    svgText = await r.text();
  } catch (e) {
    console.error("Overlay SVG konnte nicht geladen werden:", e);
    return;
  }

  overlayMount.innerHTML = svgText;

  const svg = overlayMount.querySelector("svg");
  if (!svg) {
    console.warn("Kein <svg> im geladenen Text gefunden.");
    return;
  }

  prepareDrawRobust(svg);
}

function prepareDrawRobust(svg) {
  // 1) Versuche erst deine “gallery-wall IDs”
  let animEls = svg.querySelectorAll("#overlay_lines line, #overlay_lines path, #overlay_lines polyline");
  // 2) Falls nix gefunden: animiere einfach ALLE Linien/Paths im SVG (außer dots)
  if (!animEls.length) {
    animEls = svg.querySelectorAll("line, path, polyline");
  }

  animEls.forEach((el, i) => {
    // Manche Elemente haben keine Länge (z.B. groups)
    if (typeof el.getTotalLength !== "function") return;

    const len = el.getTotalLength();
    if (!isFinite(len) || len <= 0) return;

    el.classList.add("draw-loop");

    const minFrac = 0.35;
    const minLen = len * minFrac;
    const eps = 0.8;

    el.style.setProperty("--minLen", `${minLen}`);
    el.style.setProperty("--restMin", `${len - minLen}`);
    el.style.setProperty("--maxLen", `${Math.max(len - eps, minLen)}`);
    el.style.setProperty("--restMax", `${eps}`);

    const baseDur = 4.5;
    const stagger = 0.20;
    const dur = baseDur + (i % 6) * 0.6 + Math.random() * 2.4;

    el.style.setProperty("--dur", `${dur}s`);
    el.style.setProperty("--delay", `${-(i * stagger + Math.random() * 1.6)}s`);
  });

  // Dots: wenn vorhanden, NICHT animieren
  const dots = svg.querySelectorAll("#overlay_dots circle, circle");
  dots.forEach(dot => {
    // nur Circles anfassen, wenn du willst – sonst rausnehmen
    dot.style.animation = "none";
    dot.style.strokeWidth = "var(--lineWidth)";
  });

  console.log("Overlay: animierte Elemente:", animEls.length);
}
