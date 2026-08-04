import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

export const runtime = "nodejs"
export const maxDuration = 1800

const CAD_EXTENSIONS = new Set([".dxf", ".dwg"])
const OUTPUT_FILES = new Set([
  "panel_layout_result.dxf",
  "ceiling_panel_layout_result.dxf",
  "detected_walls.dxf",
  "panel_schedule.csv",
  "panel_schedule.json",
  "detected_model.json",
  "ai_recognition.json",
])

const REVIEW_STAGES = {
  ai: [
    ["detect", "提取墙体候选…"],
    ["recognize", "请求 AI 识别…"],
  ],
  local: [["detect", "提取墙体候选…"]],
}
const JOB_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const CACHE_FILES = ["review_candidates.dxf", "review_entities.json"]

function getCacheDirectory(hash, mode) {
  return path.join(process.cwd(), "output", "cache", hash, mode)
}

async function copyCacheFiles(source, target, mode) {
  const names = mode === "ai"
    ? [...CACHE_FILES, "detected_model.json", "ai_recognition.json"]
    : CACHE_FILES
  await Promise.all(names.map((name) => copyFile(path.join(source, name), path.join(target, name))))
}

async function restoreCache(cacheDirectory, directory, inputPath, mode) {
  let checkpoint
  try {
    checkpoint = JSON.parse(
      await readFile(path.join(cacheDirectory, "conversion_checkpoint.json"), "utf8"),
    )
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }

  checkpoint.drawing_path = inputPath
  await copyCacheFiles(cacheDirectory, directory, mode)
  await writeFile(
    path.join(directory, "conversion_checkpoint.json"),
    JSON.stringify(checkpoint),
  )
  if (mode === "ai") {
    const modelPath = path.join(directory, "detected_model.json")
    const model = JSON.parse(await readFile(modelPath, "utf8"))
    model.source.path = inputPath
    await writeFile(modelPath, JSON.stringify(model, null, 2))
  }
  return checkpoint
}

async function sendReview(send, checkpoint, job, mode) {
  const directory = path.join(process.cwd(), "output", "gui", job)
  const entityMap = JSON.parse(
    await readFile(path.join(directory, "review_entities.json"), "utf8"),
  )
  const candidates = checkpoint.candidates
  const detectedWalls = new Map(
    (checkpoint.detected || candidates).walls.map((wall) => [wall.id, wall]),
  )
  const manualEdits = checkpoint.manual_edits || {
    modified_openings: [],
    added_walls: [],
    added_openings: [],
  }
  const recognizedOpenings = new Map(
    (checkpoint.recognized || candidates).walls.flatMap(
      (wall) => wall.openings.map((opening) => [opening.id, opening]),
    ),
  )
  const modifiedOpenings = new Map(
    manualEdits.modified_openings.map((opening) => [opening.id, opening]),
  )
  const manualOpeningsByWall = new Map()
  for (const opening of manualEdits.added_openings) {
    manualOpeningsByWall.set(
      opening.wallId,
      [...(manualOpeningsByWall.get(opening.wallId) || []), opening],
    )
  }
  const reviewWalls = [
    ...candidates.walls.map((wall) => ({ ...wall, manual: false })),
    ...manualEdits.added_walls.map((wall) => ({ ...wall, openings: [], manual: true })),
  ]
  send({
    type: "review",
    job,
    mode,
    entityMap,
    reviewUrl: `/api/files/${job}/review_candidates.dxf`,
    walls: reviewWalls.map((wall) => {
      const detected = detectedWalls.get(wall.id)
      const detectedOpenings = new Map(
        detected?.openings.map((opening) => [opening.id, opening]) || [],
      )
      const openings = [
        ...wall.openings.map((opening) => ({ ...opening, manual: false })),
        ...(manualOpeningsByWall.get(wall.id) || []).map((opening) => ({
          id: opening.id,
          kind: opening.kind,
          start_offset: opening.startOffset,
          end_offset: opening.endOffset,
          active: opening.active,
          manual: true,
        })),
      ]
      return {
        id: wall.id,
        start: wall.start,
        end: wall.end,
        thickness: wall.thickness,
        active: Boolean(detected),
        manual: wall.manual,
        openings: openings.map((opening) => {
          const detectedOpening = detectedOpenings.get(opening.id)
          const modifiedOpening = modifiedOpenings.get(opening.id)
          const recognizedOpening = recognizedOpenings.get(opening.id)
          const active = opening.manual
            ? opening.active
            : detectedOpening
              ? true
              : modifiedOpening
                ? modifiedOpening.kind !== "ignore"
                : Boolean(recognizedOpening)
          return {
            id: opening.id,
            kind: detectedOpening?.kind
              || (modifiedOpening?.kind !== "ignore" ? modifiedOpening?.kind : null)
              || recognizedOpening?.kind
              || opening.kind,
            active,
            startOffset: opening.start_offset,
            endOffset: opening.end_offset,
            manual: opening.manual,
          }
        }),
      }
    }),
  })
}

function runStage(stage, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "uv",
      ["run", "python", "-m", "src.conversion_worker", "--stage", stage, ...args],
      { cwd: process.cwd() },
    )
    let output = ""

    child.stdout.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-16000)
    })
    child.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-16000)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve(output)
      else reject(new Error(output.trim() || `${stage} 阶段退出，状态码 ${code}`))
    })
  })
}

function streamStages(stages, args, done) {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (data) => controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`))
        try {
          for (const [stage, message] of stages) {
            send({ type: "step", stage, message })
            await runStage(stage, args)
          }
          await done(send)
        } catch (error) {
          send({ type: "error", message: error.message })
        } finally {
          controller.close()
        }
      },
    }),
    { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
  )
}

async function confirmConversion(request) {
  const { action, job, edits } = await request.json()
  if (action !== "confirm" || !JOB_PATTERN.test(job)) {
    return Response.json({ error: "确认请求无效。" }, { status: 400 })
  }

  const directory = path.join(process.cwd(), "output", "gui", job)
  const meta = JSON.parse(await readFile(path.join(directory, "conversion_request.json"), "utf8"))
  const checkpointPath = path.join(directory, "conversion_checkpoint.json")
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8"))
  const candidates = checkpoint.candidates.walls
  const wallIds = new Set(candidates.map((wall) => wall.id))
  const openingIds = new Set(candidates.flatMap((wall) => wall.openings.map((opening) => opening.id)))
  const manualWalls = edits?.manualWalls ?? []
  const manualOpenings = edits?.manualOpenings ?? []
  if (
    !Array.isArray(edits?.walls)
    || !Array.isArray(edits?.openings)
    || !Array.isArray(manualWalls)
    || !Array.isArray(manualOpenings)
  ) {
    return Response.json({ error: "墙体修正数据无效。" }, { status: 400 })
  }
  const wallEdits = new Map(edits.walls.map((item) => [item.id, item.active]))
  const openingEdits = new Map(edits.openings.map((item) => [item.id, item.kind]))
  const manualWallIds = new Set(manualWalls.map((wall) => wall?.id))
  const manualOpeningIds = new Set(manualOpenings.map((opening) => opening?.id))
  const validPoint = (point) => (
    Array.isArray(point)
    && point.length === 2
    && point.every(Number.isFinite)
  )
  const lengthOf = (wall) => Math.hypot(
    wall.end[0] - wall.start[0],
    wall.end[1] - wall.start[1],
  )
  if (
    wallEdits.size !== wallIds.size
    || openingEdits.size !== openingIds.size
    || [...wallEdits].some(([id, active]) => !wallIds.has(id) || typeof active !== "boolean")
    || [...openingEdits].some(
      ([id, kind]) => !openingIds.has(id) || !["door", "window", "ignore"].includes(kind),
    )
  ) {
    return Response.json({ error: "墙体修正数据无效。" }, { status: 400 })
  }

  const manualWallLengths = new Map()
  if (
    manualWallIds.size !== manualWalls.length
    || manualOpeningIds.size !== manualOpenings.length
    || manualWalls.some((wall) => {
      if (
        !/^MW\d{4,}$/.test(wall?.id)
        || wallIds.has(wall.id)
        || !validPoint(wall.start)
        || !validPoint(wall.end)
        || !Number.isFinite(wall.thickness)
        || wall.thickness <= 0
        || typeof wall.active !== "boolean"
      ) return true
      const length = lengthOf(wall)
      manualWallLengths.set(wall.id, length)
      return length <= 0
    })
  ) {
    return Response.json({ error: "手绘墙体数据无效。" }, { status: 400 })
  }

  const allWallLengths = new Map(
    candidates.map((wall) => [wall.id, lengthOf(wall)]),
  )
  for (const [id, length] of manualWallLengths) allWallLengths.set(id, length)
  if (
    manualOpenings.some((opening) => (
      !/^MO\d{4,}$/.test(opening?.id)
      || openingIds.has(opening.id)
      || !allWallLengths.has(opening.wallId)
      || !Number.isFinite(opening.startOffset)
      || !Number.isFinite(opening.endOffset)
      || opening.startOffset < 0
      || opening.endOffset <= opening.startOffset
      || opening.endOffset > allWallLengths.get(opening.wallId)
      || !["door", "window"].includes(opening.kind)
      || typeof opening.active !== "boolean"
    ))
  ) {
    return Response.json({ error: "手绘门窗数据无效。" }, { status: 400 })
  }

  const recognized = checkpoint.recognized || checkpoint.detected || checkpoint.candidates
  const recognizedWalls = new Map(recognized.walls.map((wall) => [wall.id, wall]))
  const recognizedOpenings = new Map(
    recognized.walls.flatMap((wall) => wall.openings.map((opening) => [opening.id, opening])),
  )
  const previousWalls = new Map(
    (checkpoint.detected?.walls || candidates).map((wall) => [wall.id, wall]),
  )
  const manualOpeningsByWall = new Map()
  for (const opening of manualOpenings) {
    manualOpeningsByWall.set(
      opening.wallId,
      [...(manualOpeningsByWall.get(opening.wallId) || []), opening],
    )
  }
  const walls = candidates
    .filter((wall) => wallEdits.get(wall.id))
    .map((candidate) => {
      const previous = previousWalls.get(candidate.id)
      const previousOpenings = new Map(
        previous?.openings.map((opening) => [opening.id, opening]) || [],
      )
      return {
        ...(previous || {
          ...candidate,
          confidence: 1,
          evidence: ["用户确认"],
        }),
        openings: [
          ...candidate.openings
          .filter((opening) => openingEdits.get(opening.id) !== "ignore")
          .map((opening) => {
            const kind = openingEdits.get(opening.id)
            const previousOpening = previousOpenings.get(opening.id)
            return previousOpening?.kind === kind
              ? previousOpening
              : {
                  ...opening,
                  kind,
                  confidence: 1,
                  evidence: ["用户确认"],
                  source_hint: "user",
                }
          }),
          ...(manualOpeningsByWall.get(candidate.id) || [])
            .filter((opening) => opening.active)
            .map((opening) => ({
            id: opening.id,
            kind: opening.kind,
            start_offset: opening.startOffset,
            end_offset: opening.endOffset,
            confidence: 1,
            evidence: ["用户手绘"],
            source_hint: "user",
          })),
        ],
      }
    })
    .concat(manualWalls.filter((wall) => wall.active).map((wall) => ({
      id: wall.id,
      start: wall.start,
      end: wall.end,
      thickness: wall.thickness,
      source_layer: "USER_MANUAL",
      confidence: 1,
      evidence: ["用户手绘"],
      wall_type: "cleanroom_panel_wall",
      openings: (manualOpeningsByWall.get(wall.id) || [])
        .filter((opening) => opening.active)
        .map((opening) => ({
        id: opening.id,
        kind: opening.kind,
        start_offset: opening.startOffset,
        end_offset: opening.endOffset,
        confidence: 1,
        evidence: ["用户手绘"],
        source_hint: "user",
      })),
    })))
  if (!walls.length) {
    return Response.json({ error: "至少需要保留一段墙体。" }, { status: 400 })
  }

  const thicknessCounts = new Map()
  for (const wall of walls) {
    const thickness = Math.round(wall.thickness)
    thicknessCounts.set(thickness, (thicknessCounts.get(thickness) || 0) + 1)
  }
  checkpoint.recognized = recognized
  checkpoint.manual_edits = {
    modified_walls: edits.walls
      .filter((edit) => edit.active !== recognizedWalls.has(edit.id))
      .map((edit) => ({ ...edit, source: "USER" })),
    modified_openings: edits.openings
      .filter((edit) => edit.kind !== (recognizedOpenings.get(edit.id)?.kind || "ignore"))
      .map((edit) => ({ ...edit, source: "USER" })),
    added_walls: manualWalls.map((wall) => ({ ...wall, source: "USER" })),
    added_openings: manualOpenings.map((opening) => ({ ...opening, source: "USER" })),
  }
  checkpoint.detected = {
    ...checkpoint.candidates,
    walls,
    thickness_counts: [...thicknessCounts],
  }
  await writeFile(checkpointPath, JSON.stringify(checkpoint))
  if (meta.mode === "ai") {
    const modelPath = path.join(directory, "detected_model.json")
    const model = JSON.parse(await readFile(modelPath, "utf8"))
    model.recognition.manually_reviewed = true
    model.walls = model.walls.filter((wall) => wallIds.has(wall.id)).map((wall) => {
      const active = wallEdits.get(wall.id)
      const wallChanged = active !== previousWalls.has(wall.id)
      return {
        ...wall,
        install_panel: active,
        wall_type: wallChanged
          ? active ? "cleanroom_panel_wall" : "non_panel_wall"
          : wall.wall_type,
        ...(wallChanged ? { confidence: 1, evidence: ["用户确认"], source: "USER" } : {}),
        openings: [
          ...wall.openings.filter((opening) => openingIds.has(opening.id)).map((opening) => {
            const kind = openingEdits.get(opening.id)
            const finalKind = kind === "ignore" ? "other" : kind
            return opening.kind === finalKind
              ? opening
              : {
                  ...opening,
                  kind: finalKind,
                  confidence: 1,
                  evidence: ["用户确认"],
                  source: "USER",
                }
          }),
          ...(manualOpeningsByWall.get(wall.id) || [])
            .filter((opening) => opening.active && active)
            .map((opening) => ({
            id: opening.id,
            kind: opening.kind,
            source_hint: "user",
            start_offset_mm: opening.startOffset,
            end_offset_mm: opening.endOffset,
            confidence: 1,
            evidence: ["用户手绘"],
            source: "USER",
          })),
        ],
      }
    })
    model.walls.push(...manualWalls.filter((manualWall) => manualWall.active).map((manualWall) => {
      const wall = walls.find((item) => item.id === manualWall.id)
      return {
        id: wall.id,
        start: wall.start,
        end: wall.end,
        length_mm: lengthOf(wall),
        thickness_mm: wall.thickness,
        source_layer: wall.source_layer,
        layer_color: null,
        install_panel: true,
        wall_type: wall.wall_type,
        confidence: 1,
        evidence: ["用户手绘"],
        source: "USER",
        openings: wall.openings.map((opening) => ({
          id: opening.id,
          kind: opening.kind,
          source_hint: "user",
          start_offset_mm: opening.start_offset,
          end_offset_mm: opening.end_offset,
          confidence: 1,
          evidence: ["用户手绘"],
          source: "USER",
        })),
      }
    }))
    model.low_confidence_ids = model.walls.flatMap((wall) => [
      ...(wall.confidence < 0.85 ? [wall.id] : []),
      ...wall.openings
        .filter((opening) => opening.confidence < 0.85)
        .map((opening) => opening.id),
    ])
    await writeFile(modelPath, JSON.stringify(model, null, 2))
  }

  const cacheDirectory = getCacheDirectory(meta.sourceHash, meta.mode)
  await mkdir(cacheDirectory, { recursive: true })
  await copyCacheFiles(directory, cacheDirectory, meta.mode)
  await Promise.all([
    writeFile(
      path.join(cacheDirectory, "conversion_checkpoint.json"),
      JSON.stringify(checkpoint),
    ),
    writeFile(
      path.join(cacheDirectory, "metadata.json"),
      JSON.stringify({
        fileName: meta.sourceName,
        sha256: meta.sourceHash,
        mode: meta.mode,
        updatedAt: new Date().toISOString(),
      }, null, 2),
    ),
  ])

  return streamStages(
    [["generate", "生成排版图和材料清单…"]],
    meta.args,
    async (send) => {
      const files = (await readdir(directory))
        .filter((name) => OUTPUT_FILES.has(name))
        .map((name) => ({ name, url: `/api/files/${job}/${name}` }))
      send({ type: "done", job, mode: meta.mode, files })
    },
  )
}

export async function POST(request) {
  try {
    if (request.headers.get("content-type")?.startsWith("application/json")) {
      return await confirmConversion(request)
    }

    const form = await request.formData()
    const cad = form.get("cad")
    const materials = form.get("materials")
    const mode = form.get("mode")
    const extension = cad instanceof File ? path.extname(cad.name).toLowerCase() : ""

    if (!(cad instanceof File) || !CAD_EXTENSIONS.has(extension)) {
      return Response.json({ error: "请选择 DXF 或 DWG 图纸。" }, { status: 400 })
    }
    if (cad.size > 100 * 1024 * 1024) {
      return Response.json({ error: "CAD 图纸不能超过 100 MB。" }, { status: 400 })
    }
    if (mode !== "ai" && mode !== "local") {
      return Response.json({ error: "转换模式无效。" }, { status: 400 })
    }
    if (materials instanceof File && materials.size > 1024 * 1024) {
      return Response.json({ error: "材料配置不能超过 1 MB。" }, { status: 400 })
    }

    const content = Buffer.from(await cad.arrayBuffer())
    const sourceHash = createHash("sha256").update(content).digest("hex")
    const job = randomUUID()
    const directory = path.join(process.cwd(), "output", "gui", job)
    const inputPath = path.join(directory, `source${extension}`)
    const outputPath = path.join(directory, "panel_layout_result.dxf")
    let materialsPath = path.join(process.cwd(), "input", "materials.json")

    await mkdir(directory, { recursive: true })
    await writeFile(inputPath, content)

    if (materials instanceof File && materials.size) {
      const content = Buffer.from(await materials.arrayBuffer())
      JSON.parse(content.toString("utf8"))
      materialsPath = path.join(directory, "materials.json")
      await writeFile(materialsPath, content)
    }

    const args = [
      "--mode",
      mode,
      "--input",
      inputPath,
      "--materials",
      materialsPath,
      "--output",
      outputPath,
    ]
    await writeFile(
      path.join(directory, "conversion_request.json"),
      JSON.stringify({ mode, args, sourceHash, sourceName: cad.name }),
    )
    const cached = await restoreCache(
      getCacheDirectory(sourceHash, mode),
      directory,
      inputPath,
      mode,
    )
    if (cached) {
      return streamStages([], args, async (send) => {
        send({ type: "step", stage: "cache", message: "已读取本地识别缓存。" })
        await sendReview(send, cached, job, mode)
      })
    }

    return streamStages(REVIEW_STAGES[mode], args, async (send) => {
      const checkpoint = JSON.parse(
        await readFile(path.join(directory, "conversion_checkpoint.json"), "utf8"),
      )
      await sendReview(send, checkpoint, job, mode)
    })
  } catch (error) {
    const message = error instanceof SyntaxError ? "materials.json 不是有效的 JSON。" : error.message
    return Response.json({ error: message }, { status: 500 })
  }
}
