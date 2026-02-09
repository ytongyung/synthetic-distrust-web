import express from "express"
import path from "path"
import fs from "fs"
import { fileURLToPath } from "url"
import { generateOne, generatePrompt } from "./index.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const SIMULATE_ONLY = String(process.env.SIMULATE_ONLY || "").toLowerCase() === "true"
  || String(process.env.SIMULATE_ONLY || "") === "1"
const PROMPT_SOURCE = (process.env.PROMPT_SOURCE || (SIMULATE_ONLY ? "out" : "lists")).toLowerCase()

const app = express()
app.use(express.json())

const outDir = path.join(__dirname, "out")
const publicDir = path.join(__dirname, "public")
const fontFiles = {
  "Redaction-Italic.otf": path.join(__dirname, "Redaction-Italic.otf"),
  "Redaction-Regular.otf": path.join(__dirname, "Redaction-Regular.otf"),
  "Geist-Regular.otf": path.join(__dirname, "Geist-Regular.otf")
}

const breaker = {
  openUntil: 0,
  slowCount: 0,
  failCount: 0
};

function breakerOpen() {
  return Date.now() < breaker.openUntil;
}

function tripBreaker(ms) {
  breaker.openUntil = Date.now() + ms;
  breaker.slowCount = 0;
  breaker.failCount = 0;
}

if (!fs.existsSync(publicDir)) fs.mkdirSync(publicDir, { recursive: true })
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true })

app.get("/fonts/:name", (req, res) => {
  const file = fontFiles[req.params.name]
  if (!file) return res.sendStatus(404)
  res.sendFile(file)
})

app.use("/out", (req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*")
  next()
}, express.static(outDir))
app.use(express.static("public"));

app.get("/", (req, res) => res.redirect("/gallery"));

app.get("/sphere", (req, res) => res.sendFile(path.join(__dirname, "public", "sphere.html")));
app.get("/gallery", (req, res) => res.sendFile(path.join(__dirname, "public", "gallery-wall.html")));
app.get("/control", (req, res) => res.sendFile(path.join(__dirname, "public", "control.html")));
app.get("/debug", (req, res) => res.sendFile(path.join(__dirname, "public", "debug.html")));

app.use("/3d", express.static("3dpublic"))

function listImages() {
  if (!fs.existsSync(outDir)) return []

  const files = fs.readdirSync(outDir)
  return files
    .filter(f => /\.(png|jpe?g|webp)$/i.test(f))
    .filter(f => !f.startsWith("._") && f !== ".DS_Store")
    .sort()
    .reverse()
}

function listImagesWithMeta() {
  const imgs = listImages()
  return imgs.filter((img) => {
    const json = img.replace(/\.(png|jpe?g|webp)$/i, ".json")
    return fs.existsSync(path.join(outDir, json))
  })
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function pickFallbackFromOut() {
  const imgs = listImages();
  if (!imgs.length) return null;

  // bevorzugt Bilder mit Meta JSON daneben
  const candidates = imgs.filter((img) => {
    const json = img.replace(/\.(png|jpe?g|webp)$/i, ".json");
    return fs.existsSync(path.join(outDir, json));
  });

  const pool = candidates.length ? candidates : imgs;
  const file = pool[Math.floor(Math.random() * pool.length)];

  // Prompt/Meta optional laden
  const jsonFile = file.replace(/\.(png|jpe?g|webp)$/i, ".json");
  const metaPath = path.join(outDir, jsonFile);
  let meta = null;
  try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}

  const prompt =
    (meta?.prompt && String(meta.prompt).trim())
      ? String(meta.prompt).trim()
      : [meta?.places, meta?.people, meta?.atmosphere, meta?.gossip, meta?.style].filter(Boolean).join(", ");

  return { file, meta, prompt };
}

function pickPromptFromOut() {
  const imgs = listImagesWithMeta()
  if (!imgs.length) return null
  const file = imgs[Math.floor(Math.random() * imgs.length)]
  const jsonFile = file.replace(/\.(png|jpe?g|webp)$/i, ".json")
  const metaPath = path.join(outDir, jsonFile)
  let meta = null
  try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) } catch {}
  if (!meta) return null

  const prompt =
    (meta?.prompt && String(meta.prompt).trim())
      ? String(meta.prompt).trim()
      : [meta?.places, meta?.people, meta?.atmosphere, meta?.gossip, meta?.style].filter(Boolean).join(", ")

  const picked = {
    places: meta?.places || "",
    people: meta?.people || "",
    atmosphere: meta?.atmosphere || "",
    gossip: meta?.gossip || "",
    style: meta?.style || ""
  }

  return { prompt, picked, file }
}

async function simulateRun({ runId, fallback }) {
  // ein paar “fake” Events fuer debug.js
  broadcast({ type: "sim_start", runId, ts: Date.now(), prompt: fallback.prompt || "" });
  await sleep(1500);
  broadcast({ type: "picked", runId, ts: Date.now(), file: fallback.file });
  await sleep(2000);
  broadcast({ type: "mutated", runId, ts: Date.now(), mutationMode: "fallback", mutationFields: [] });
  await sleep(1500);
  broadcast({ type: "asset_written", runId, ts: Date.now(), file: fallback.file });

  // wichtig: UI soll das Bild “wie neu” behandeln
  broadcast({ type: "new", file: fallback.file });

  await sleep(2000);
  broadcast({ type: "run_done", runId, file: fallback.file, simulated: true, ts: Date.now() });
  return fallback.file;
}

app.get("/api/images", (req, res) => {
  res.json({ images: listImagesWithMeta() })
})

const clients = new Set()

app.get("/api/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  })
  res.write("\n")
  clients.add(res)
  req.on("close", () => clients.delete(res))
})

app.post("/api/prompt", (req, res) => {
  try {
    if (PROMPT_SOURCE === "out") {
      const picked = pickPromptFromOut()
      if (picked) {
        return res.json({ ok: true, prompt: picked.prompt, picked: picked.picked, sourceFile: picked.file })
      }
      // fallback auf Listen, falls keine Metas vorhanden
    }
    const result = generatePrompt({
      parentMeta: req.body?.parentMeta || null,
      parentFile: req.body?.parentFile || null,
      mutationMode: req.body?.mutationMode || null
    })
    return res.json({ ok: true, prompt: result.prompt, picked: result.picked })
  } catch (e) {
    console.error("api prompt error", e && e.stack ? e.stack : e)
    return res.status(500).json({ ok: false, error: String(e) })
  }
})

function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`
  for (const res of clients) res.write(data)
}

let lastSnapshot = new Set(listImages())

setInterval(() => {
  const now = new Set(listImages())
  for (const f of now) {
    if (!lastSnapshot.has(f)) broadcast({ type: "new", file: f })
  }
  lastSnapshot = now
}, 800)

app.post("/api/generate", async (req, res) => {
  const runId = (req.body && req.body.runId) || String(Date.now());
  const TIMEOUT_MS = 60_000;

  try {
    if (SIMULATE_ONLY) {
      broadcast({ type: "run_start", runId, simulated: true });
      const fb = pickFallbackFromOut();
      if (!fb) {
        broadcast({ type: "run_error", runId, error: "simulate-only + no fallback images" });
        return res.status(503).json({ ok: false, runId, error: "simulate-only + no fallback" });
      }
      const file = await simulateRun({ runId, fallback: fb });
      return res.json({ ok: true, runId, file, simulated: true, reason: "simulate_only" });
    }

    console.log("breaker", {
      now: Date.now(),
      openUntil: breaker.openUntil,
      open: breakerOpen(),
      slowCount: breaker.slowCount,
      failCount: breaker.failCount
    });
    broadcast({ type: "run_start", runId });

    const controller = new AbortController();

    // Wenn Replicate gerade "kaputt/zu langsam" ist: sofort Fallback
    if (breakerOpen()) {
      controller.abort();
      const fb = pickFallbackFromOut();
      if (!fb) {
        broadcast({ type: "run_error", runId, error: "breaker open + no fallback images" });
        return res.status(503).json({ ok: false, runId, error: "breaker open + no fallback" });
      }
      const file = await simulateRun({ runId, fallback: fb });
      return res.json({ ok: true, runId, file, simulated: true, breaker: true });
    }

    const startedAt = Date.now();

    const genPromise = generateOne({
      runId,
      signal: controller.signal,
      onEvent: evt => {
        broadcast({
          type: evt.stage,
          runId: evt.runId,
          ts: evt.ts,
          ...evt.data
        });
      },
      parentMeta: req.body?.parentMeta,
      parentFile: req.body?.parentFile,
      mutationMode: req.body?.mutationMode,
      promptOverride: req.body?.promptOverride,
      pickedOverride: req.body?.pickedOverride
    }).then(file => ({ kind: "real", file }))
      .catch(error => ({ kind: "error", error }));

    const timeoutPromise = sleep(TIMEOUT_MS).then(() => ({ kind: "timeout" }));

    const result = await Promise.race([genPromise, timeoutPromise]);

    if (result.kind === "timeout") {
      console.log("TIMEOUT -> fallback", { runId });
      controller.abort();
      breaker.slowCount += 1;

      // Wenn's wiederholt langsam ist: Breaker 2 Minuten oeffnen
      if (breaker.slowCount >= 2) tripBreaker(2 * 60_000);

      const fb = pickFallbackFromOut();
      if (!fb) {
        broadcast({ type: "run_error", runId, error: "timeout + no fallback images" });
        return res.status(503).json({ ok: false, runId, error: "timeout + no fallback" });
      }
      const file = await simulateRun({ runId, fallback: fb });
      return res.json({ ok: true, runId, file, simulated: true, reason: "timeout" });
    }

    if (result.kind === "error") throw result.error;

    // Erfolg: Breaker wieder beruhigen
    const dur = Date.now() - startedAt;
    if (dur < TIMEOUT_MS) breaker.slowCount = 0;
    breaker.failCount = 0;

    broadcast({ type: "run_done", runId, file: result.file, ts: Date.now() });
    return res.json({ ok: true, file: result.file, runId, simulated: false });

  } catch (e) {
    // Abort zaehlt NICHT als Fehler
    if (e?.name !== "AbortError") {
      breaker.failCount += 1;
      if (breaker.failCount >= 5) tripBreaker(2 * 60_000);
    }

    console.error("api generate error", e && e.stack ? e.stack : e);

    // Fallback auf vorhandenes Bild, falls moeglich
    const fb = pickFallbackFromOut();
    if (fb) {
      const file = await simulateRun({ runId, fallback: fb });
      return res.status(200).json({ ok: true, runId, file, simulated: true, reason: "error_fallback" });
    }

    broadcast({ type: "run_error", runId, error: String(e) });
    return res.status(500).json({ ok: false, error: String(e), runId });
  }
})

app.post("/api/mutate", async (req, res) => {
  const { parent, mode } = req.body || {}

  if (!parent) return res.status(400).json({ ok: false, error: "parent fehlt" })
  if (!["pass", "distort", "drift"].includes(mode)) {
    return res.status(400).json({ ok: false, error: "mode muss pass, distort oder drift sein" })
  }

  // parent json finden
  const parentJson = parent.replace(/\.(png|jpe?g|webp)$/i, ".json")
  const parentJsonPath = path.join(outDir, parentJson)

  if (!fs.existsSync(parentJsonPath)) {
    return res.status(404).json({ ok: false, error: "parent meta json nicht gefunden: " + parentJson })
  }

  const parentMeta = JSON.parse(fs.readFileSync(parentJsonPath, "utf8"))

  const runId = "mut_" + Date.now()
  const TIMEOUT_MS = 60_000

  try {
    if (SIMULATE_ONLY) {
      broadcast({ type: "run_start", runId, parent, mode, simulated: true })
      const fb = pickFallbackFromOut()
      if (!fb) {
        broadcast({ type: "run_error", runId, error: "simulate-only + no fallback images" })
        return res.status(503).json({ ok: false, runId, error: "simulate-only + no fallback" })
      }
      const file = await simulateRun({ runId, fallback: fb })
      return res.json({ ok: true, runId, file, simulated: true, reason: "simulate_only" })
    }

    broadcast({ type: "run_start", runId, parent, mode })

    const controller = new AbortController()

    // Wenn Replicate gerade "kaputt/zu langsam" ist: sofort Fallback
    if (breakerOpen()) {
      controller.abort()
      const fb = pickFallbackFromOut()
      if (!fb) {
        broadcast({ type: "run_error", runId, error: "breaker open + no fallback images" })
        return res.status(503).json({ ok: false, runId, error: "breaker open + no fallback" })
      }
      const file = await simulateRun({ runId, fallback: fb })
      return res.json({ ok: true, runId, file, simulated: true, breaker: true })
    }

    const startedAt = Date.now()

    const genPromise = generateOne({
      runId,
      signal: controller.signal,
      parentFile: parent,
      parentMeta,
      mutationMode: mode,
      onEvent: evt => {
        broadcast({
          type: evt.stage,
          runId: evt.runId,
          ts: evt.ts,
          ...evt.data
        })
      }
    }).then(file => ({ kind: "real", file }))
      .catch(error => ({ kind: "error", error }))

    const timeoutPromise = sleep(TIMEOUT_MS).then(() => ({ kind: "timeout" }))

    const result = await Promise.race([genPromise, timeoutPromise])

    if (result.kind === "timeout") {
      console.log("TIMEOUT -> fallback", { runId });
      controller.abort()
      breaker.slowCount += 1

      // Wenn's wiederholt langsam ist: Breaker 2 Minuten oeffnen
      if (breaker.slowCount >= 2) tripBreaker(2 * 60_000)

      const fb = pickFallbackFromOut()
      if (!fb) {
        broadcast({ type: "run_error", runId, error: "timeout + no fallback images" })
        return res.status(503).json({ ok: false, runId, error: "timeout + no fallback" })
      }
      const file = await simulateRun({ runId, fallback: fb })
      return res.json({ ok: true, runId, file, simulated: true, reason: "timeout" })
    }

    if (result.kind === "error") throw result.error

    // Erfolg: Breaker wieder beruhigen
    const dur = Date.now() - startedAt
    if (dur < TIMEOUT_MS) breaker.slowCount = 0
    breaker.failCount = 0

    broadcast({ type: "run_done", runId, file: result.file, parent, mode, ts: Date.now() })
    return res.json({ ok: true, file: result.file, runId, simulated: false })
  } catch (e) {
    breaker.failCount += 1
    if (breaker.failCount >= 2) tripBreaker(2 * 60_000)

    console.error("api mutate error", e && e.stack ? e.stack : e)

    const fb = pickFallbackFromOut()
    if (fb) {
      const file = await simulateRun({ runId, fallback: fb })
      return res.status(200).json({ ok: true, runId, file, simulated: true, reason: "error_fallback" })
    }

    broadcast({ type: "run_error", runId, error: String(e) })
    return res.status(500).json({ ok: false, error: String(e), runId })
  }
})
app.post("/api/control/orbit", (req, res) => {
  const { dx = 0, dy = 0 } = req.body || {}
  // kleine Sanity checks
  const ndx = Math.max(-1, Math.min(1, Number(dx) || 0))
  const ndy = Math.max(-1, Math.min(1, Number(dy) || 0))
  broadcast({ type: "control_orbit", dx: ndx, dy: ndy, ts: Date.now() })
  res.json({ ok: true })
})

app.post("/api/control/pan", (req, res) => {
  const { dy = 0 } = req.body || {}
  const ndy = Math.max(-1, Math.min(1, Number(dy) || 0))
  broadcast({ type: "control_pan", dy: ndy, ts: Date.now() })
  res.json({ ok: true })
})

app.post("/api/control/zoom", (req, res) => {
  const { zoom = 0.5 } = req.body || {}
  const nz = Math.max(0, Math.min(1, Number(zoom)))
  broadcast({ type: "control_zoom", zoom: Number.isFinite(nz) ? nz : 0.5, ts: Date.now() })
  res.json({ ok: true })
})

app.post("/api/control/reset", (req, res) => {
  broadcast({ type: "control_reset", ts: Date.now() })
  res.json({ ok: true })
})

app.post("/api/breaker/reset", (req, res) => {
  breaker.openUntil = 0;
  breaker.slowCount = 0;
  breaker.failCount = 0;
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000
app.listen(PORT, () => {
  console.log(`Webserver läuft auf http://localhost:${PORT}`)
})
