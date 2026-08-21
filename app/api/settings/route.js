import {
  deletePreset,
  readPresetStore,
  savePreset,
  setDefaultPreset,
} from "@/lib/presets"

export const runtime = "nodejs"

export async function GET() {
  return Response.json(await readPresetStore(), {
    headers: { "Cache-Control": "no-store" },
  })
}

export async function POST(request) {
  try {
    const body = await request.json()
    if (body.action === "save") {
      return Response.json(await savePreset(body.preset))
    }
    if (body.action === "set-default") {
      return Response.json({ store: await setDefaultPreset(body.id) })
    }
    if (body.action === "delete") {
      return Response.json({ store: await deletePreset(body.id) })
    }
    return Response.json({ error: "设置操作无效。" }, { status: 400 })
  } catch (error) {
    return Response.json({ error: error.message }, { status: 400 })
  }
}
