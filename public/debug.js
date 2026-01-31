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
  const charsPerFrame = 0.6
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

const es = new EventSource("/api/stream")
es.onmessage = (e) => {
  try {
    const data = JSON.parse(e.data)
    if (data?.type && String(data.type).startsWith("control_")) return
    if (data && (data.type === "run_done" || data.type === "asset_written")) {
      lineInstant(data)
      if (data.type === "run_done") reloadWhenIdle = true
    } else {
      line(data)
      if (data && data.type === "run_error") reloadWhenIdle = true
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
