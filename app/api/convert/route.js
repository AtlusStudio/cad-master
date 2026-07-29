import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, writeFile } from "node:fs/promises"
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

const STAGES = {
  ai: [
    ["detect", "提取墙体候选…"],
    ["recognize", "请求 AI 识别…"],
    ["generate", "生成排版图和材料清单…"],
  ],
  local: [
    ["detect", "提取墙体候选…"],
    ["generate", "生成排版图和材料清单…"],
  ],
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

export async function POST(request) {
  try {
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

    const job = randomUUID()
    const directory = path.join(process.cwd(), "output", "gui", job)
    const inputPath = path.join(directory, `source${extension}`)
    const outputPath = path.join(directory, "panel_layout_result.dxf")
    let materialsPath = path.join(process.cwd(), "input", "materials.json")

    await mkdir(directory, { recursive: true })
    await writeFile(inputPath, Buffer.from(await cad.arrayBuffer()))

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
    const encoder = new TextEncoder()

    return new Response(
      new ReadableStream({
        async start(controller) {
          const send = (data) => controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`))
          try {
            for (const [stage, message] of STAGES[mode]) {
              send({ type: "step", stage, message })
              await runStage(stage, args)
            }
            const files = (await readdir(directory))
              .filter((name) => OUTPUT_FILES.has(name))
              .map((name) => ({ name, url: `/api/files/${job}/${name}` }))
            send({ type: "done", job, mode, files })
          } catch (error) {
            send({ type: "error", message: error.message })
          } finally {
            controller.close()
          }
        },
      }),
      { headers: { "Content-Type": "application/x-ndjson; charset=utf-8" } },
    )
  } catch (error) {
    const message = error instanceof SyntaxError ? "materials.json 不是有效的 JSON。" : error.message
    return Response.json({ error: message }, { status: 500 })
  }
}
