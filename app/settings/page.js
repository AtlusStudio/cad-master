"use client"

import { useEffect, useState } from "react"

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
  ["min_cut_width", "最小收边宽", "mm", "吊顶边缘切板允许的最小宽度"],
  ["large_room_ratio", "独立房间比例", "0–1", "面积达到总吊顶面积此比例的房间单独排板"],
  ["text_height", "吊顶标注字高", "mm", "吊顶板尺寸文字的高度"],
]

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
    <label className="setting-field">
      <span>
        <b>{label}</b>
        <small>{help}</small>
      </span>
      <span className="number-control">
        <input
          type="number"
          step="any"
          value={section[name]}
          onChange={(event) => onChange(name, event.target.value)}
          required
        />
        <i>{unit}</i>
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
    <main className="workspace settings-workspace">
      <SiteHeader active="settings" />

      <section className="settings-intro">
        <div>
          <p className="eyebrow">CONFIGURATION LIBRARY / 参数库</p>
          <h1>把项目规则，<br />保存成可复用预设。</h1>
          <p className="lede">
            每个预设同时管理墙体识别、门窗判断、墙板与吊顶排板参数。转换图纸前选择一次，整条处理链使用同一套规则。
          </p>
        </div>
        <div className="preset-index" aria-label="预设概览">
          <span>PRESET REGISTER</span>
          <strong>{String(catalog?.presets.length || 0).padStart(2, "0")}</strong>
          <p>套可用参数</p>
          <i>AI 连接密钥仍由服务器 .env 管理</i>
        </div>
      </section>

      <section className="settings-shell">
        <aside className="preset-rail">
          <div className="preset-rail-heading">
            <div>
              <span>预设目录</span>
              <small>选择一套参数进行编辑</small>
            </div>
            <button type="button" disabled={!activePreset} onClick={() => createPreset(activePreset)}>
              + 新建
            </button>
          </div>
          <div className="preset-list">
            {!catalog && <p className="preset-loading">正在读取参数库…</p>}
            {catalog?.presets.map((preset, index) => (
              <button
                className={preset.id === activeId ? "is-active" : ""}
                type="button"
                key={preset.id}
                onClick={() => selectPreset(preset)}
              >
                <span>P-{String(index + 1).padStart(2, "0")}</span>
                <strong>{preset.name}</strong>
                <small>
                  墙厚 {preset.drawing.wall_thicknesses.join(" / ")} · 墙板 {preset.materials.primary_width} · 吊顶 {preset.ceiling.panel_width}
                </small>
                {preset.id === catalog.defaultPresetId && <i>DEFAULT</i>}
              </button>
            ))}
          </div>
          <div className="preset-rail-note">
            <span>使用方式</span>
            <p>保存后返回转换工作台，在“选择预设”中指定本次图纸使用的规则。</p>
          </div>
        </aside>

        <form className="settings-form" onSubmit={save}>
          {draft ? (
            <>
              <div className="settings-form-heading">
                <div>
                  <p>{draft.id ? "EDIT PRESET" : "NEW PRESET"}</p>
                  <input
                    className="preset-name-input"
                    value={draft.name}
                    onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                    aria-label="预设名称"
                    required
                  />
                  <textarea
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
                <div className="settings-form-actions">
                  {draft.id && (
                    <>
                      <button type="button" onClick={() => createPreset(activePreset, true)}>复制</button>
                      <button type="button" onClick={remove}>删除</button>
                      <button
                        type="button"
                        disabled={catalog.defaultPresetId === activeId}
                        onClick={setDefault}
                      >
                        {catalog.defaultPresetId === activeId ? "当前默认" : "设为默认"}
                      </button>
                    </>
                  )}
                  <button className="save-preset" type="submit" disabled={notice.type === "saving"}>
                    保存预设
                  </button>
                </div>
              </div>

              {notice.message && <p className={`settings-notice is-${notice.type}`}>{notice.message}</p>}

              <fieldset className="settings-group">
                <legend>
                  <span>01</span>
                  <strong>墙体识别</strong>
                  <small>控制双线墙候选的筛选与几何合并</small>
                </legend>
                <div className="settings-grid">
                  <label className="setting-field setting-field-wide">
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
                  <label className="setting-field setting-field-wide">
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

              <fieldset className="settings-group">
                <legend>
                  <span>02</span>
                  <strong>门窗与交接</strong>
                  <small>控制洞口尺度、对齐判断和墙体端部预留</small>
                </legend>
                <div className="settings-grid">
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

              <fieldset className="settings-group">
                <legend>
                  <span>03</span>
                  <strong>墙板材料与排板</strong>
                  <small>替代原来的 input/materials.json 和临时材料文件</small>
                </legend>
                <div className="settings-grid">
                  <label className="setting-field setting-field-wide">
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

              <fieldset className="settings-group">
                <legend>
                  <span>04</span>
                  <strong>吊顶排板</strong>
                  <small>控制吊顶板规格、切分、区域分组与标注</small>
                </legend>
                <div className="settings-grid">
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

              <fieldset className="settings-group">
                <legend>
                  <span>05</span>
                  <strong>图纸标注</strong>
                  <small>控制墙板输出图中的板宽文字尺寸和离墙距离</small>
                </legend>
                <div className="settings-grid">
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
            <div className="settings-empty">
              <strong>参数库尚未就绪</strong>
              <p>{notice.message || "正在读取预设。"}</p>
            </div>
          )}
        </form>
      </section>

      <footer>
        <span>CAD MASTER / PRESET LIBRARY</span>
        <span>预设保存在当前项目的 data/db/cad-master.sqlite</span>
      </footer>
    </main>
  )
}
