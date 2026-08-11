import { readFile } from "node:fs/promises"
import path from "node:path"

export const runtime = "nodejs"

const OUTPUT_FILES = new Set([
  "panel_layout_result.dxf",
  "ceiling_panel_layout_result.dxf",
  "detected_walls.dxf",
  "panel_schedule.csv",
  "panel_schedule.json",
  "preset.json",
  "detected_model.json",
  "ai_recognition.json",
  "review_candidates.dxf",
])

export async function GET(_request, { params }) {
  const { job, name } = await params
  if (!/^[0-9a-f-]{36}$/.test(job) || !OUTPUT_FILES.has(name)) {
    return new Response("文件不存在", { status: 404 })
  }

  try {
    const file = await readFile(path.join(process.cwd(), "data", "jobs", job, name))
    return new Response(file, {
      headers: {
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
        "Content-Type": name.endsWith(".json")
          ? "application/json; charset=utf-8"
          : name.endsWith(".csv")
            ? "text/csv; charset=utf-8"
            : "application/dxf",
      },
    })
  } catch {
    return new Response("文件不存在", { status: 404 })
  }
}
