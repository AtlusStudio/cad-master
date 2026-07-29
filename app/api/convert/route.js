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

function runConversion(args, onStep) {
  return new Promise((resolve, reject) => {
    const child = spawn("uv", ["run", "main.py", ...args], { cwd: process.cwd() })
    let output = ""
    let pending = ""

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString()
      output = `${output}${text}`.slice(-16000)
      const lines = `${pending}${text}`.split(/\r?\n/)
      pending = lines.pop()
      lines.filter((line) => /^\[\d+\/\d+\]/.test(line)).forEach(onStep)
    })
    child.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-16000)
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (/^\[\d+\/\d+\]/.test(pending)) onStep(pending)
      if (code === 0) resolve(output)
      else reject(new Error(output.trim() || `转换进程退出，状态码 ${code}`))
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

    const args = ["--input", inputPath, "--materials", materialsPath, "--output", outputPath]
    if (mode === "local") args.push("--local-recognition")
    const encoder = new TextEncoder()

    return new Response(
      new ReadableStream({
        async start(controller) {
          const send = (data) => controller.enqueue(encoder.encode(`${JSON.stringify(data)}\n`))
          try {
            await runConversion(args, (message) => send({ type: "step", message }))
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
