import { createHash, randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import path from "node:path"

const { DatabaseSync } = process.getBuiltinModule("node:sqlite")

const DATABASE_PATH = path.join(process.cwd(), "data", "db", "cad-master.sqlite")
const DEFAULT_PRESET = {
  id: "default-cleanroom",
  name: "默认洁净室",
  description: "沿用项目当前的墙体识别与 580 / 1180 mm 彩钢板排板参数。",
  drawing: {
    snap_tolerance: 1,
    angle_tolerance: 0.1,
    parallel_overlap_ratio: 0.9,
    wall_colors: [1, 6],
    wall_thicknesses: [50, 75, 100],
    wall_thickness_tolerance: 10,
    min_wall_length: 300,
    opening_min_width: 300,
    opening_max_width: 3000,
    opening_jamb_tolerance: 300,
    opening_alignment_tolerance: 150,
    text_height: 125,
    text_offset: 150,
    junction_reserve: 5,
    tolerance: 1,
  },
  materials: {
    standard_widths: [580, 1180],
    joint_gap: 3,
    primary_width: 1180,
    min_cut_width: 150,
    cut_step: 5,
    end_tolerance: 2.5,
  },
  ceiling: {
    panel_width: 1180,
    max_length: 3000,
    joint_gap: 0,
    min_cut_width: 150,
    text_height: 125,
    size_variety_weight: 40,
    panel_count_weight: 25,
    full_width_weight: 35,
  },
}

let database

function getDatabase() {
  if (database) return database
  mkdirSync(path.dirname(DATABASE_PATH), { recursive: true })
  database = new DatabaseSync(DATABASE_PATH)
  database.exec(`
    CREATE TABLE IF NOT EXISTS presets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      drawing TEXT NOT NULL,
      materials TEXT NOT NULL,
      ceiling TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS presets_one_default
      ON presets(is_default) WHERE is_default = 1;
  `)
  if (database.prepare("SELECT COUNT(*) AS count FROM presets").get().count === 0) {
    const timestamp = new Date().toISOString()
    database.prepare(`
      INSERT INTO presets (
        id, name, description, drawing, materials, ceiling, created_at, updated_at, is_default
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      DEFAULT_PRESET.id,
      DEFAULT_PRESET.name,
      DEFAULT_PRESET.description,
      JSON.stringify(DEFAULT_PRESET.drawing),
      JSON.stringify(DEFAULT_PRESET.materials),
      JSON.stringify(DEFAULT_PRESET.ceiling),
      timestamp,
      timestamp,
    )
  }
  return database
}

function presetFromRow(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    drawing: JSON.parse(row.drawing),
    materials: JSON.parse(row.materials),
    ceiling: { ...DEFAULT_PRESET.ceiling, ...JSON.parse(row.ceiling) },
  }
}

function numeric(value, label, minimum = 0, allowMinimum = true) {
  const result = Number(value)
  if (!Number.isFinite(result) || (allowMinimum ? result < minimum : result <= minimum)) {
    throw new Error(`${label}必须是${allowMinimum ? `不小于 ${minimum}` : `大于 ${minimum}`}的数字。`)
  }
  return result
}

function numericList(value, label) {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label}不能为空。`)
  return [...new Set(value.map((item) => numeric(item, label, 0, false)))]
}

function normalizeDrawing(input = {}) {
  const wallColors = numericList(input.wall_colors, "墙体颜色")
  if (wallColors.some((color) => !Number.isInteger(color) || color > 255)) {
    throw new Error("墙体颜色必须是 1–255 的 ACI 整数。")
  }
  const drawing = {
    snap_tolerance: numeric(input.snap_tolerance, "吸附容差", 0, false),
    angle_tolerance: numeric(input.angle_tolerance, "角度容差", 0, false),
    parallel_overlap_ratio: numeric(input.parallel_overlap_ratio, "双线重合比例", 0, false),
    wall_colors: wallColors,
    wall_thicknesses: numericList(input.wall_thicknesses, "墙厚"),
    wall_thickness_tolerance: numeric(input.wall_thickness_tolerance, "墙厚容差"),
    min_wall_length: numeric(input.min_wall_length, "最短墙长", 0, false),
    opening_min_width: numeric(input.opening_min_width, "最小洞口宽度", 0, false),
    opening_max_width: numeric(input.opening_max_width, "最大洞口宽度", 0, false),
    opening_jamb_tolerance: numeric(input.opening_jamb_tolerance, "洞口边框容差"),
    opening_alignment_tolerance: numeric(input.opening_alignment_tolerance, "洞口对齐容差"),
    text_height: numeric(input.text_height, "标注字高", 0, false),
    text_offset: numeric(input.text_offset, "标注偏移"),
    junction_reserve: numeric(input.junction_reserve, "墙体交接预留"),
    tolerance: numeric(input.tolerance, "计算容差", 0, false),
  }
  if (drawing.parallel_overlap_ratio > 1) throw new Error("双线重合比例不能大于 1。")
  if (drawing.opening_max_width < drawing.opening_min_width) {
    throw new Error("最大洞口宽度不能小于最小洞口宽度。")
  }
  return drawing
}

function normalizeMaterials(input = {}) {
  const materials = {
    standard_widths: numericList(input.standard_widths, "标准板宽"),
    joint_gap: numeric(input.joint_gap, "板缝宽度"),
    primary_width: numeric(input.primary_width, "主板宽", 0, false),
    min_cut_width: numeric(input.min_cut_width, "最小非标板宽", 0, false),
    cut_step: numeric(input.cut_step, "非标板模数", 0, false),
    end_tolerance: numeric(input.end_tolerance, "尾差容差"),
  }
  if (!materials.standard_widths.includes(materials.primary_width)) {
    throw new Error("主板宽必须包含在标准板宽中。")
  }
  return materials
}

function normalizeCeiling(input = {}) {
  const ceiling = {
    panel_width: numeric(input.panel_width, "吊顶板宽", 0, false),
    max_length: numeric(input.max_length, "吊顶最大板长", 0, false),
    joint_gap: numeric(input.joint_gap, "吊顶板缝宽度"),
    min_cut_width: numeric(input.min_cut_width, "吊顶最小收边宽", 0, false),
    text_height: numeric(input.text_height, "吊顶标注字高", 0, false),
    size_variety_weight: numeric(input.size_variety_weight, "板块规格种类权重"),
    panel_count_weight: numeric(input.panel_count_weight, "板块总数权重"),
    full_width_weight: numeric(input.full_width_weight, "保留原板宽权重"),
  }
  if (Math.abs(ceiling.size_variety_weight + ceiling.panel_count_weight + ceiling.full_width_weight - 100) > 1e-6) {
    throw new Error("三个吊顶排板权重必须合计 100%。")
  }
  return ceiling
}

function normalizePreset(input, current) {
  const name = String(input?.name || "").trim()
  if (!name) throw new Error("预设名称不能为空。")
  const timestamp = new Date().toISOString()
  return {
    id: current?.id || `preset-${randomUUID()}`,
    name,
    description: String(input.description || "").trim(),
    createdAt: current?.createdAt || timestamp,
    updatedAt: timestamp,
    drawing: normalizeDrawing(input.drawing),
    materials: normalizeMaterials(input.materials),
    ceiling: normalizeCeiling(input.ceiling),
  }
}

export async function readPresetStore() {
  const rows = getDatabase().prepare("SELECT * FROM presets ORDER BY created_at, id").all()
  return {
    version: 1,
    defaultPresetId: rows.find((row) => row.is_default)?.id || null,
    presets: rows.map(presetFromRow),
  }
}

export async function savePreset(input) {
  const db = getDatabase()
  const row = input?.id ? db.prepare("SELECT * FROM presets WHERE id = ?").get(input.id) : null
  const preset = normalizePreset(input, row && presetFromRow(row))
  db.prepare(`
    INSERT INTO presets (id, name, description, drawing, materials, ceiling, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      drawing = excluded.drawing,
      materials = excluded.materials,
      ceiling = excluded.ceiling,
      updated_at = excluded.updated_at
  `).run(
    preset.id,
    preset.name,
    preset.description,
    JSON.stringify(preset.drawing),
    JSON.stringify(preset.materials),
    JSON.stringify(preset.ceiling),
    preset.createdAt,
    preset.updatedAt,
  )
  return { store: await readPresetStore(), preset }
}

export async function setDefaultPreset(id) {
  const db = getDatabase()
  if (!db.prepare("SELECT 1 FROM presets WHERE id = ?").get(id)) {
    throw new Error("找不到要设为默认值的预设。")
  }
  db.exec("BEGIN")
  try {
    db.exec("UPDATE presets SET is_default = 0")
    db.prepare("UPDATE presets SET is_default = 1 WHERE id = ?").run(id)
    db.exec("COMMIT")
  } catch (error) {
    db.exec("ROLLBACK")
    throw error
  }
  return readPresetStore()
}

export async function deletePreset(id) {
  const db = getDatabase()
  const row = db.prepare("SELECT is_default FROM presets WHERE id = ?").get(id)
  if (!row) throw new Error("找不到要删除的预设。")
  if (db.prepare("SELECT COUNT(*) AS count FROM presets").get().count === 1) {
    throw new Error("至少需要保留一个预设。")
  }
  db.prepare("DELETE FROM presets WHERE id = ?").run(id)
  if (row.is_default) {
    const replacement = db.prepare("SELECT id FROM presets ORDER BY created_at, id LIMIT 1").get()
    db.prepare("UPDATE presets SET is_default = 1 WHERE id = ?").run(replacement.id)
  }
  return readPresetStore()
}

export async function getPreset(id) {
  const row = getDatabase().prepare("SELECT * FROM presets WHERE id = ?").get(id)
  if (!row) throw new Error("请选择一个有效的设置预设。")
  return presetFromRow(row)
}

export function presetFingerprint(preset) {
  const { text_height, text_offset, ...detection } = preset.drawing
  return createHash("sha256")
    .update(JSON.stringify(detection))
    .digest("hex")
}
