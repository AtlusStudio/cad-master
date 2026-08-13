"use client"

import { useEffect, useState } from "react"
import { Copy, Plus, Save, Star, Trash2 } from "lucide-react"

import SiteHeader from "../site-header"

const DRAWING_FIELDS = [
  ["snap_tolerance", "吸附容差", "mm", "合并几何端点时允许的距离"],
  ["angle_tolerance", "角度容差", "°", "判断平行与共线时允许的角度偏差"],
  ["parallel_overlap_ratio", "双线重合比例", "0–1", "双线投影至少重合多少才作为墙体"],
  ["wall_thickness_tolerance", "墙厚容差", "mm", "匹配标准墙厚时允许的上下偏差"],
  ["min_wall_length", "最短墙长", "mm", "短于此值的线段不作为墙体"],
  ["tolerance", "计算容差", "mm", "排板精确匹配与垂直判断使用的容差"],
]

const OPENING_FIELDS = [
  ["opening_min_width", "最小洞口宽度", "mm", "门窗候选允许的最小宽度"],
  ["opening_max_width", "最大洞口宽度", "mm", "门窗候选允许的最大宽度"],
  ["opening_jamb_tolerance", "边框连续容差", "mm", "连续门窗洞口之间允许保留的边框"],
  ["opening_alignment_tolerance", "洞口对齐容差", "mm", "门窗几何与墙轴之间允许的偏差"],
  ["junction_reserve", "墙体交接预留", "mm", "T 型墙和吊顶边界使用的安装预留"],
]

const MATERIAL_FIELDS = [
  ["joint_gap", "板缝宽度", "mm", "相邻彩钢板之间的实际拼缝"],
  ["primary_width", "主板宽", "mm", "优先使用的标准板宽，必须包含在标准板宽中"],
  ["min_cut_width", "最小非标板宽", "mm", "非标收边板允许的最小宽度"],
  ["cut_step", "非标板模数", "mm", "非标板宽按此模数归整"],
  ["end_tolerance", "尾差容差", "mm", "模数归整后允许由墙端吸收的误差"],
]

const CEILING_FIELDS = [
  ["panel_width", "吊顶板宽", "mm", "吊顶沿短边方向使用的标准板宽"],
  ["max_length", "最大板长", "mm", "吊顶单块板沿长边方向允许的最大长度"],
  ["joint_gap", "吊顶板缝", "mm", "相邻吊顶板之间的拼缝宽度"],
  ["min_cut_width", "最小收边宽", "mm", "多种排法中优先避免小于该宽度的收边板"],
  ["text_height", "吊顶标注字高", "mm", "吊顶板尺寸文字的高度"],
  ["size_variety_weight", "规格种类权重", "%", "同一排板单位内，减少不同板块规格的权重"],
  ["panel_count_weight", "板块总数权重", "%", "同一排板单位内，减少板块总数量的权重"],
  ["full_width_weight", "保留原板宽权重", "%", "优先保留完整吊顶板宽，减少沿宽度裁切；三项权重须合计 100%"],
]

const GROUP_CLASS = "mt-8 border-0 p-0 [&>legend]:mb-4 [&>legend]:flex [&>legend]:w-full [&>legend]:items-baseline [&>legend]:gap-3 [&>legend]:border-b [&>legend]:border-slate-200 [&>legend]:pb-3 [&>legend>span]:font-mono [&>legend>span]:text-[9px] [&>legend>span]:font-bold [&>legend>span]:text-[#ff6b2c] [&>legend>strong]:text-sm [&>legend>small]:ml-auto [&>legend>small]:hidden [&>legend>small]:text-[10px] [&>legend>small]:font-normal [&>legend>small]:text-slate-400 sm:[&>legend>small]:block"
const GRID_CLASS = "grid gap-3 lg:grid-cols-2"
const WIDE_FIELD_CLASS = "flex min-w-0 flex-col gap-3 border border-slate-200 bg-slate-50/60 p-4 sm:flex-row sm:items-center sm:justify-between [&>span]:min-w-0 [&_b]:block [&_b]:text-xs [&_b]:font-semibold [&_small]:mt-1 [&_small]:block [&_small]:text-[10px] [&_small]:leading-4 [&_small]:text-slate-400 [&>input]:h-10 [&>input]:w-full [&>input]:shrink-0 [&>input]:border [&>input]:border-slate-300 [&>input]:bg-white [&>input]:px-3 [&>input]:font-mono [&>input]:text-xs [&>input]:outline-none [&>input]:focus:border-[#153b5b] sm:[&>input]:w-56"

function formFromPreset(preset) {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    drawing: {
      ...preset.drawing,
      wall_colors: preset.drawing.wall_colors.join(", "),
      wall_thicknesses: preset.drawing.wall_thicknesses.join(", "),
    },
    materials: {
      ...preset.materials,
      standard_widths: preset.materials.standard_widths.join(", "),
    },
    ceiling: { ...preset.ceiling },
  }
}

function parseNumberList(value) {
  return String(value)
    .split(/[，,\s]+/)
    .filter(Boolean)
    .map(Number)
}

function presetFromForm(form) {
  return {
    ...form,
    drawing: {
      ...form.drawing,
      wall_colors: parseNumberList(form.drawing.wall_colors),
      wall_thicknesses: parseNumberList(form.drawing.wall_thicknesses),
    },
    materials: {
      ...form.materials,
      standard_widths: parseNumberList(form.materials.standard_widths),
    },
  }
}

function NumberField({ field, section, onChange }) {
  const [name, label, unit, help] = field
  return (
    <label className="flex min-w-0 flex-col gap-3 border border-slate-200 bg-slate-50/60 p-4 sm:flex-row sm:items-center sm:justify-between">
      <span className="min-w-0">
        <b className="block text-xs font-semibold">{label}</b>
        <small className="mt-1 block text-[10px] leading-4 text-slate-400">{help}</small>
      </span>
      <span className="flex h-10 w-full shrink-0 border border-slate-300 bg-white focus-within:border-[#153b5b] sm:w-36">
        <input
          className="min-w-0 flex-1 bg-transparent px-3 text-right font-mono text-xs outline-none"
          type="number"
          step="any"
          value={section[name]}
          onChange={(event) => onChange(name, event.target.value)}
          required
        />
        <i className="grid min-w-10 place-items-center border-l border-slate-200 px-2 font-mono text-[9px] not-italic text-slate-400">{unit}</i>
      </span>
    </label>
  )
}

export default function SettingsPage() {
  const [catalog, setCatalog] = useState(null)
  const [activeId, setActiveId] = useState("")
  const [draft, setDraft] = useState(null)
  const [notice, setNotice] = useState({ type: "idle", message: "" })

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || "无法读取预设。")
        return result
      })
      .then((result) => {
        const selected = result.presets.find((preset) => preset.id === result.defaultPresetId)
          || result.presets[0]
        setCatalog(result)
        setActiveId(selected.id)
        setDraft(formFromPreset(selected))
      })
      .catch((error) => setNotice({ type: "error", message: error.message }))
  }, [])

  function selectPreset(preset) {
    setActiveId(preset.id)
    setDraft(formFromPreset(preset))
    setNotice({ type: "idle", message: "" })
  }

  function createPreset(source, duplicate = false) {
    setActiveId("")
    setDraft({
      ...formFromPreset(source),
      id: null,
      name: duplicate ? `${source.name} 副本` : "新预设",
      description: duplicate ? source.description : "",
    })
    setNotice({ type: "idle", message: "" })
  }

  function updateSection(section, name, value) {
    setDraft((current) => ({
      ...current,
      [section]: { ...current[section], [name]: value },
    }))
  }

  async function sendAction(body) {
    setNotice({ type: "saving", message: "正在保存…" })
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error || "保存失败。")
    return result
  }

  async function save(event) {
    event.preventDefault()
    try {
      const result = await sendAction({ action: "save", preset: presetFromForm(draft) })
      setCatalog(result.store)
      setActiveId(result.preset.id)
      setDraft(formFromPreset(result.preset))
      setNotice({ type: "success", message: "预设已保存。" })
    } catch (error) {
      setNotice({ type: "error", message: error.message })
    }
  }

  async function setDefault() {
    try {
      const result = await sendAction({ action: "set-default", id: activeId })
      setCatalog(result.store)
      setNotice({ type: "success", message: "已设为转换工作台的默认预设。" })
    } catch (error) {
      setNotice({ type: "error", message: error.message })
    }
  }

  async function remove() {
    if (!window.confirm(`删除预设“${draft.name}”？`)) return
    try {
      const result = await sendAction({ action: "delete", id: activeId })
      const selected = result.store.presets.find(
        (preset) => preset.id === result.store.defaultPresetId,
      ) || result.store.presets[0]
      setCatalog(result.store)
      setActiveId(selected.id)
      setDraft(formFromPreset(selected))
      setNotice({ type: "success", message: "预设已删除。" })
    } catch (error) {
      setNotice({ type: "error", message: error.message })
    }
  }

  const activePreset = catalog?.presets.find((preset) => preset.id === activeId)

  return (
    <div className="min-h-screen lg:flex">
      <SiteHeader active="settings" />
      <main className="min-w-0 flex-1">
        <header className="flex min-h-[76px] items-center justify-between border-b border-slate-200 bg-white px-5 sm:px-8">
          <div><p className="font-mono text-[9px] font-bold tracking-[.18em] text-[#ff6b2c]">CONFIGURATION LIBRARY</p><h1 className="mt-1 text-xl font-bold tracking-tight">参数预设</h1></div>
          <div className="text-right"><strong className="font-mono text-xl">{String(catalog?.presets.length || 0).padStart(2, "0")}</strong><small className="ml-2 text-[10px] text-slate-400">套可用参数</small></div>
        </header>

        <section className="grid min-h-[calc(100vh-76px)] xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="border-b border-slate-200 bg-[#e7ebef] p-4 xl:border-b-0 xl:border-r xl:p-5">
          <div className="flex items-center justify-between border-b border-slate-300 pb-4">
            <div>
              <span className="block text-xs font-bold">预设目录</span>
              <small className="mt-1 block text-[10px] text-slate-500">选择一套参数进行编辑</small>
            </div>
            <button className="inline-flex items-center gap-1.5 bg-[#153b5b] px-3 py-2 text-xs font-semibold text-white hover:bg-[#0f2d46] disabled:opacity-40" type="button" disabled={!activePreset} onClick={() => createPreset(activePreset)}>
              <Plus className="size-3.5" aria-hidden="true" />新建
            </button>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
            {!catalog && <p className="p-4 text-xs text-slate-400">正在读取参数库…</p>}
            {catalog?.presets.map((preset, index) => (
              <button
                className={`relative min-w-0 border p-4 text-left transition-colors ${preset.id === activeId ? "border-[#153b5b] bg-white shadow-sm" : "border-transparent bg-white/40 hover:bg-white/70"}`}
                type="button"
                key={preset.id}
                onClick={() => selectPreset(preset)}
              >
                <span className="font-mono text-[9px] text-[#ff6b2c]">P-{String(index + 1).padStart(2, "0")}</span>
                <strong className="mt-2 block truncate text-xs">{preset.name}</strong>
                <small className="mt-2 block truncate font-mono text-[9px] text-slate-400">
                  墙厚 {preset.drawing.wall_thicknesses.join(" / ")} · 墙板 {preset.materials.primary_width} · 吊顶 {preset.ceiling.panel_width}
                </small>
                {preset.id === catalog.defaultPresetId && <i className="absolute right-3 top-3 bg-emerald-100 px-1.5 py-1 font-mono text-[8px] not-italic text-emerald-700">DEFAULT</i>}
              </button>
            ))}
          </div>
          <div className="mt-5 border-l-2 border-[#ff6b2c] pl-3 text-[10px] leading-5 text-slate-500">
            <span className="font-bold text-slate-700">使用方式</span>
            <p>保存后返回转换工作台，选择本次图纸使用的规则。</p>
          </div>
        </aside>

        <form className="min-w-0 bg-white p-5 sm:p-8 [&_textarea]:w-full [&_textarea]:resize-none [&_textarea]:border [&_textarea]:border-slate-300 [&_textarea]:px-3 [&_textarea]:py-2 [&_textarea]:text-xs [&_textarea]:outline-none [&_textarea]:focus:border-[#153b5b]" onSubmit={save}>
          {draft ? (
            <>
              <div className="flex flex-col gap-5 border-b border-slate-200 pb-6 lg:flex-row lg:items-start lg:justify-between">
                <div className="max-w-2xl flex-1">
                  <p className="font-mono text-[9px] tracking-[.16em] text-[#ff6b2c]">{draft.id ? "EDIT PRESET" : "NEW PRESET"}</p>
                  <input
                    className="mt-2 w-full border-0 border-b border-transparent bg-transparent p-0 text-3xl font-bold tracking-[-.04em] outline-none focus:border-slate-300"
                    value={draft.name}
                    onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                    aria-label="预设名称"
                    required
                  />
                  <textarea className="mt-3"
                    value={draft.description}
                    onChange={(event) => setDraft((current) => ({
                      ...current,
                      description: event.target.value,
                    }))}
                    placeholder="说明这套参数适用于哪些项目或图纸"
                    aria-label="预设说明"
                    rows="2"
                  />
                </div>
                <div className="flex flex-wrap gap-2 [&_button]:inline-flex [&_button]:items-center [&_button]:gap-1.5 [&_button]:border [&_button]:border-slate-300 [&_button]:bg-white [&_button]:px-3 [&_button]:py-2 [&_button]:text-[10px] [&_button]:font-semibold [&_button]:hover:bg-slate-50 [&_button]:disabled:opacity-40 [&_svg]:size-3.5">
                  {draft.id && (
                    <>
                      <button type="button" onClick={() => createPreset(activePreset, true)}><Copy aria-hidden="true" />复制</button>
                      <button type="button" onClick={remove}><Trash2 aria-hidden="true" />删除</button>
                      <button
                        type="button"
                        disabled={catalog.defaultPresetId === activeId}
                        onClick={setDefault}
                      >
                        <Star aria-hidden="true" />
                        {catalog.defaultPresetId === activeId ? "当前默认" : "设为默认"}
                      </button>
                    </>
                  )}
                  <button className="!border-[#ff6b2c] !bg-[#ff6b2c] !text-white hover:!bg-[#e9551b]" type="submit" disabled={notice.type === "saving"}>
                    <Save aria-hidden="true" />保存预设
                  </button>
                </div>
              </div>

              {notice.message && <p className={`mt-4 border-l-4 p-3 text-xs ${notice.type === "error" ? "border-red-500 bg-red-50 text-red-700" : notice.type === "success" ? "border-emerald-500 bg-emerald-50 text-emerald-700" : "border-sky-500 bg-sky-50 text-sky-700"}`}>{notice.message}</p>}

              <fieldset className={GROUP_CLASS}>
                <legend>
                  <span>01</span>
                  <strong>墙体识别</strong>
                  <small>控制双线墙候选的筛选与几何合并</small>
                </legend>
                <div className={GRID_CLASS}>
                  <label className={WIDE_FIELD_CLASS}>
                    <span>
                      <b>墙体 ACI 颜色</b>
                      <small>本地模式只提取这些颜色；AI 模式把它们作为可靠碎线依据</small>
                    </span>
                    <input
                      type="text"
                      value={draft.drawing.wall_colors}
                      onChange={(event) => updateSection("drawing", "wall_colors", event.target.value)}
                      placeholder="1, 6"
                      required
                    />
                  </label>
                  <label className={WIDE_FIELD_CLASS}>
                    <span>
                      <b>允许墙厚</b>
                      <small>使用逗号分隔多个厚度，单位 mm</small>
                    </span>
                    <input
                      type="text"
                      value={draft.drawing.wall_thicknesses}
                      onChange={(event) => updateSection("drawing", "wall_thicknesses", event.target.value)}
                      placeholder="50, 75, 100"
                      required
                    />
                  </label>
                  {DRAWING_FIELDS.map((field) => (
                    <NumberField
                      field={field}
                      section={draft.drawing}
                      onChange={(name, value) => updateSection("drawing", name, value)}
                      key={field[0]}
                    />
                  ))}
                </div>
              </fieldset>

              <fieldset className={GROUP_CLASS}>
                <legend>
                  <span>02</span>
                  <strong>门窗与交接</strong>
                  <small>控制洞口尺度、对齐判断和墙体端部预留</small>
                </legend>
                <div className={GRID_CLASS}>
                  {OPENING_FIELDS.map((field) => (
                    <NumberField
                      field={field}
                      section={draft.drawing}
                      onChange={(name, value) => updateSection("drawing", name, value)}
                      key={field[0]}
                    />
                  ))}
                </div>
              </fieldset>

              <fieldset className={GROUP_CLASS}>
                <legend>
                  <span>03</span>
                  <strong>墙板材料与排板</strong>
                  <small>替代原来的 input/materials.json 和临时材料文件</small>
                </legend>
                <div className={GRID_CLASS}>
                  <label className={WIDE_FIELD_CLASS}>
                    <span>
                      <b>标准板宽</b>
                      <small>使用逗号分隔多个板宽，单位 mm</small>
                    </span>
                    <input
                      type="text"
                      value={draft.materials.standard_widths}
                      onChange={(event) => updateSection("materials", "standard_widths", event.target.value)}
                      placeholder="580, 1180"
                      required
                    />
                  </label>
                  {MATERIAL_FIELDS.map((field) => (
                    <NumberField
                      field={field}
                      section={draft.materials}
                      onChange={(name, value) => updateSection("materials", name, value)}
                      key={field[0]}
                    />
                  ))}
                </div>
              </fieldset>

              <fieldset className={GROUP_CLASS}>
                <legend>
                  <span>04</span>
                  <strong>吊顶排板</strong>
                  <small>控制吊顶板规格、切分、区域分组与标注</small>
                </legend>
                <div className={GRID_CLASS}>
                  {CEILING_FIELDS.map((field) => (
                    <NumberField
                      field={field}
                      section={draft.ceiling}
                      onChange={(name, value) => updateSection("ceiling", name, value)}
                      key={field[0]}
                    />
                  ))}
                </div>
              </fieldset>

              <fieldset className={GROUP_CLASS}>
                <legend>
                  <span>05</span>
                  <strong>图纸标注</strong>
                  <small>控制墙板输出图中的板宽文字尺寸和离墙距离</small>
                </legend>
                <div className={GRID_CLASS}>
                  <NumberField
                    field={["text_height", "标注字高", "mm", "输出 DXF 中的板宽文字高度"]}
                    section={draft.drawing}
                    onChange={(name, value) => updateSection("drawing", name, value)}
                  />
                  <NumberField
                    field={["text_offset", "标注偏移", "mm", "板宽文字中心距离墙轴的距离"]}
                    section={draft.drawing}
                    onChange={(name, value) => updateSection("drawing", name, value)}
                  />
                </div>
              </fieldset>
            </>
          ) : (
            <div className="grid min-h-72 place-items-center border border-dashed border-slate-200 bg-slate-50 text-center">
              <div><strong className="text-sm">参数库尚未就绪</strong><p className="mt-2 text-xs text-slate-400">{notice.message || "正在读取预设。"}</p></div>
            </div>
          )}
        </form>
        </section>
      </main>
    </div>
  )
}
