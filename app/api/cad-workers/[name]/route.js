import { readFile } from "node:fs/promises"
import path from "node:path"

export const runtime = "nodejs"

const WORKERS = new Set(["dxf-parser-worker.js", "mtext-renderer-worker.js"])

export async function GET(_request, { params }) {
  const { name } = await params
  if (!WORKERS.has(name)) return new Response("文件不存在", { status: 404 })

  const file = await readFile(
    path.join(process.cwd(), "node_modules", "@mlightcad", "cad-simple-viewer", "dist", name),
  )
  return new Response(file, {
    headers: {
      "Cache-Control": "public, max-age=3600",
      "Content-Type": "text/javascript; charset=utf-8",
    },
  })
}
