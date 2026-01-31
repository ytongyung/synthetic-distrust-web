import "dotenv/config"
import fs from "fs"
import path from "path"
import Replicate from "replicate"
import { fileURLToPath, pathToFileURL } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function readLines(relPath) {
  const p = path.join(__dirname, relPath)
  if (!fs.existsSync(p)) throw new Error("Datei fehlt: " + relPath)

  const raw = fs.readFileSync(p, "utf8")

  const lines = raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => l.replace(/\s+/g, " "))

  if (lines.length === 0) throw new Error("Keine Zeilen gefunden in: " + relPath)
  return lines
}

function pickOne(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function ensureOutDir() {
  const dir = path.join(__dirname, "out")
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    const err = new Error("aborted")
    err.name = "AbortError"
    throw err
  }
}

async function downloadUrlToFile(url, filePath, signal) {
  throwIfAborted(signal)
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error("Download Fehler " + res.status)
  const buf = Buffer.from(await res.arrayBuffer())
  throwIfAborted(signal)
  fs.writeFileSync(filePath, buf)
}

function pickImageFromOutput(output) {
  const candidates = []

  const walk = v => {
    if (!v) return
    if (typeof v === "string") candidates.push(v)
    if (Array.isArray(v)) v.forEach(walk)
    if (typeof v === "object") {
      if (typeof v.url === "string") candidates.push(v.url)
      if (typeof v.href === "string") candidates.push(v.href)
      if (typeof v.image === "string") candidates.push(v.image)
      if (typeof v.image_base64 === "string") candidates.push(v.image_base64)
      if (typeof v.imageBase64 === "string") candidates.push(v.imageBase64)
      if (typeof v.data === "string") candidates.push(v.data)
      if (typeof v.output === "string") candidates.push(v.output)
      if (typeof v.output === "object") walk(v.output)
    }
  }

  walk(output)

  const url = candidates.find(s => typeof s === "string" && s.startsWith("http"))
  if (url) return { kind: "url", value: url }

  const dataUrl = candidates.find(s => typeof s === "string" && s.startsWith("data:image"))
  if (dataUrl) return { kind: "dataurl", value: dataUrl }

  const b64 = candidates.find(s => typeof s === "string" && s.length > 200 && !s.includes(" "))
  if (b64) return { kind: "base64", value: b64 }

  return { kind: "none", value: "" }
}

function buildPrompt(p) {
  const placeWeight = 2
  const placeLines = Array.from({ length: placeWeight }, () => `Place: ${p.places}`).join(
    "\n"
  )
  const gossipWeight = 4
  const gossipLines = Array.from({ length: gossipWeight }, () => `Gossip: ${p.gossip}`).join(
    "\n"
  )
  return `
Photorealistic candid smartphone snapshot.
Documentary look, unposed, imperfect framing, slight motion blur, direct phone flash.
Real colors, no studio lighting, no retouching.

${placeLines}
People: ${p.people}
Atmosphere: ${p.atmosphere}
${gossipLines}
Style: ${p.style}

No text, no logos, no watermark.
`.trim()
}

function buildHeadline(p) {
  const people = p.people || "Celebrity"
  const places = p.places || "the city"
  const gossip = p.gossip || "shock twist"
  const atmosphere = p.atmosphere || "wild scene"
  const style = p.style || "exclusive"

  const templates = [
    `${people} stuns in ${places}`,
    `${people}: ${gossip} in ${places}`,
    `${people} caught in ${places}`,
    `${gossip} as ${people} steps out`,
    `${people} in ${places} - ${atmosphere}`,
    `${people} spotted - ${style}`
  ]

  return pickOne(templates)
}

function cleanHeadline(raw, fallback) {
  if (!raw || typeof raw !== "string") return fallback
  const firstLine = raw.split(/\r?\n/)[0] || ""
  const cleaned = firstLine
    .replace(/^["“”'`]+|["“”'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned) return fallback
  return cleaned.length > 120 ? cleaned.slice(0, 117).trim() + "…" : cleaned
}

function extractHeadlineText(output) {
  if (!output) return ""
  if (typeof output === "string") return output
  if (Array.isArray(output)) {
    return output
      .map(v => (typeof v === "string" ? v : ""))
      .join("")
      .trim()
  }
  if (typeof output === "object") {
    if (typeof output.text === "string") return output.text
    if (typeof output.output === "string") return output.output
  }
  return ""
}

async function generateHeadline(replicate, picked, emit) {
  emit("picked", { picked })
  return ""
}

function pickDifferent(list, current) {
  if (!Array.isArray(list) || list.length === 0) return current
  if (list.length === 1) return list[0]
  let next = current
  let guard = 0
  while (next === current && guard++ < 20) next = pickOne(list)
  return next
}

function normalizeFromList(value, list) {
  if (!Array.isArray(list) || list.length === 0) return value
  return list.includes(value) ? value : pickOne(list)
}

function mutatePicked(base, lists, mode) {
  const next = { ...base }

  const fields = ["gossip", "places", "atmosphere", "people"] // style lassen wir stabil
  const changeCount = mode === "pass" ? 1 : mode === "distort" ? 2 : 3

  // wähle Felder zufällig ohne doppelte
  const shuffled = fields.sort(() => Math.random() - 0.5)
  const chosen = shuffled.slice(0, Math.min(changeCount, fields.length))

  for (const f of chosen) {
    if (f === "gossip") next.gossip = pickDifferent(lists.gossipWords, next.gossip)
    if (f === "places") next.places = pickDifferent(lists.placesWords, next.places)
    if (f === "atmosphere") next.atmosphere = pickDifferent(lists.atmosphereWords, next.atmosphere)
    if (f === "people") next.people = pickDifferent(lists.peopleWords, next.people)
  }

  return { next, chosen }
}

export async function generateOne(opts = {}) {
  const {
    runId = String(Date.now()),
    onEvent,
    signal,
    parentMeta = null,
    mutationMode = null,
    parentFile = null
  } = opts

  function throwIfAborted() {
    if (signal?.aborted) {
      const err = new Error("aborted")
      err.name = "AbortError"
      throw err
    }
  }

  const emit = (stage, data = {}) => {
    onEvent?.({ stage, runId, ts: Date.now(), data })
  }

  let prediction = null

  throwIfAborted()

  const token = process.env.REPLICATE_API_TOKEN
  if (!token) throw new Error("REPLICATE_API_TOKEN fehlt")

  const replicate = new Replicate({ auth: token })
  const outDir = ensureOutDir()

  const atmosphereWords = readLines("prompts/atmosphere.txt")
  const gossipWords = readLines("prompts/gossip.txt")
  const peopleWords = readLines("prompts/people.txt")
  const placesWords = readLines("prompts/places.txt")
  const styleWords = readLines("prompts/style.txt")

  const lists = { atmosphereWords, gossipWords, peopleWords, placesWords, styleWords }

  // optional: von Parent ableiten
  // parentMeta, mutationMode, parentFile come from params

  let picked
  let mutationFields = []

  if (parentMeta && mutationMode) {
    const base = {
      atmosphere: normalizeFromList(parentMeta.atmosphere, atmosphereWords),
      gossip: normalizeFromList(parentMeta.gossip, gossipWords),
      people: normalizeFromList(parentMeta.people, peopleWords),
      places: normalizeFromList(parentMeta.places, placesWords),
      style: normalizeFromList(parentMeta.style, styleWords)
    }

    const { next, chosen } = mutatePicked(base, {
      atmosphereWords,
      gossipWords,
      peopleWords,
      placesWords
    }, mutationMode)

    picked = next
    mutationFields = chosen
    emit("mutated", { mutationMode, mutationFields, parent: parentFile || null })
  } else {
    picked = {
      atmosphere: pickOne(atmosphereWords),
      gossip: pickOne(gossipWords),
      people: pickOne(peopleWords),
      places: pickOne(placesWords),
      style: pickOne(styleWords)
    }
  }

  const prompt = buildPrompt(picked)
  const headline = await generateHeadline(replicate, picked, emit)
  emit("headline_ready", { headline })

  console.log("")
  console.log("Zeilen Auswahl:")
  console.log(picked)
  console.log("")
  console.log("Prompt:")
  console.log(prompt)
  console.log("")

  const imageRequest = {
    model: "google/nano-banana-pro",
    input: { prompt, aspect_ratio: "9:16" }
  }
  emit("image_request", imageRequest)

  try {
    throwIfAborted()
    prediction = await replicate.predictions.create(imageRequest)
    throwIfAborted()
    emit("prediction_created", { id: prediction.id, status: prediction.status, created_at: prediction.created_at, urls: prediction.urls })

    let lastStatus = prediction.status
    emit("prediction_status", { id: prediction.id, status: prediction.status })

    while (true) {
      throwIfAborted()
      prediction = await replicate.predictions.get(prediction.id)
      if (prediction.status !== lastStatus) {
        lastStatus = prediction.status
        emit("prediction_status", { id: prediction.id, status: prediction.status, started_at: prediction.started_at, completed_at: prediction.completed_at, logs: prediction.logs, output: prediction.output, urls: prediction.urls })
      }
      if (prediction.status === "succeeded") break
      if (prediction.status === "failed") throw new Error(prediction.error || "prediction failed")

      await sleep(800)
    }

    const image = pickImageFromOutput(prediction.output)
    throwIfAborted()
    const stamp = Date.now()
    const filename = `img_${stamp}.png`
    const filePath = path.join(outDir, filename)

    // mutationMode hier NICHT nochmal deklarieren, es existiert oben schon

    const parentGeneration =
      parentMeta && typeof parentMeta.generation === "number" ? parentMeta.generation : 0

    const generation = parentMeta && mutationMode ? parentGeneration + 1 : 0

    const meta = {
      ...picked,
      prompt,
      headline,
      createdAt: new Date(stamp).toISOString(),

      // loop metadata
      parent: parentMeta && mutationMode ? parentFile : null,
      generation,
      mutation: parentMeta && mutationMode ? mutationMode : null,
      mutationFields: parentMeta && mutationMode ? mutationFields : []
    }
    throwIfAborted()
    const jsonPath = path.join(outDir, `img_${stamp}.json`)
    fs.writeFileSync(jsonPath, JSON.stringify(meta, null, 2))

    if (image.kind === "url") {
      await downloadUrlToFile(image.value, filePath, signal)
      emit("asset_written", { filename, kind: "url" })
      return filename
    }

    if (image.kind === "dataurl") {
      throwIfAborted()
      const b64 = image.value.split(",").pop()
      fs.writeFileSync(filePath, Buffer.from(b64, "base64"))
      emit("asset_written", { filename, kind: "dataurl" })
      return filename
    }

    if (image.kind === "base64") {
      throwIfAborted()
      fs.writeFileSync(filePath, Buffer.from(image.value, "base64"))
      emit("asset_written", { filename, kind: "base64" })
      return filename
    }

    throw new Error("Kein Bild gefunden")
  } catch (err) {
    if (err?.name === "AbortError") {
      if (prediction?.id) {
        try { await replicate.predictions.cancel(prediction.id) } catch {}
      }
      throw err
    }
    throw err
  }
}

function isRunDirectly() {
  const arg = process.argv[1]
  return arg && import.meta.url === pathToFileURL(arg).href
}

if (isRunDirectly()) {
  generateOne()
    .then(f => console.log("Fertig:", f))
    .catch(e => {
      console.error(e?.message || e)
      process.exitCode = 1
    })
}
