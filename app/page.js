"use client"

import { useEffect, useState } from "react"

import CadReview from "./cad-review"
import SiteHeader from "./site-header"

const FILE_LABELS = {
  "panel_layout_result.dxf": "墙板排版图",
  "ceiling_panel_layout_result.dxf": "吊顶排版图",
  "detected_walls.dxf": "墙体识别图",
  "panel_schedule.csv": "材料清单 CSV",
  "panel_schedule.json": "材料清单 JSON",
  "preset.json": "本次设置预设",
  "detected_model.json": "识别模型",
  "ai_recognition.json": "AI 原始结果",
}

function formatSize(size) {
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export default function Home() {
  const [cadFile, setCadFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [presets, setPresets] = useState([])
  const [selectedPresetId, setSelectedPresetId] = useState("")
  const [presetError, setPresetError] = useState("")
  const [state, setState] = useState({ status: "idle" })

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || "无法读取设置预设。")
        return result
      })
      .then((result) => {
        setPresets(result.presets)
        setSelectedPresetId(result.defaultPresetId || result.presets[0]?.id || "")
      })
      .catch((error) => setPresetError(error.message))
  }, [])

  function selectCad(file) {
    if (file && !/\.(dxf|dwg)$/i.test(file.name)) {
      setState({ status: "error", message: "请拖入 DXF 或 DWG 图纸。" })
      return
    }
    setCadFile(file || null)
    setState({ status: "idle" })
  }

  async function convert(mode) {
    if (!cadFile) {
      setState({ status: "error", message: "请先选择一个 DXF 或 DWG 图纸。" })
      return
    }
    const selectedPreset = presets.find((preset) => preset.id === selectedPresetId)
    if (!selectedPreset) {
      setState({ status: "error", message: presetError || "请先选择一个设置预设。" })
      return
    }

    const data = new FormData()
    data.append("cad", cadFile)
    data.append("mode", mode)
    data.append("presetId", selectedPreset.id)
    setState({ status: "detecting", mode, presetName: selectedPreset.name, logs: [] })

    try {
      const response = await fetch("/api/convert", { method: "POST", body: data })
      await readEvents(response)
    } catch (error) {
      setState({ status: "error", message: error.message })
    }
  }

  async function readEvents(response) {
    if (!response.ok) {
      const result = await response.json()
      throw new Error(result.error || "转换失败")
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done })
      const lines = buffer.split("\n")
      buffer = lines.pop()
      for (const line of lines) {
        if (!line) continue
        const event = JSON.parse(line)
        if (event.type === "step") {
          setState((current) => ({ ...current, logs: [...current.logs, event.message] }))
        } else if (event.type === "review") {
          setState((current) => ({ ...current, status: "review", ...event }))
        } else if (event.type === "done") {
          setState((current) => ({ ...current, status: "success", ...event }))
        } else if (event.type === "error") {
          throw new Error(event.message)
        }
      }
      if (done) break
    }
  }

  async function confirmWalls() {
    setState((current) => ({ ...current, status: "converting" }))
    try {
      const response = await fetch("/api/convert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "confirm",
          job: state.job,
          edits: {
            walls: state.walls
              .filter((wall) => !wall.manual)
              .map((wall) => ({ id: wall.id, active: wall.active })),
            openings: state.walls.flatMap((wall) => wall.openings
              .filter((opening) => !opening.manual)
              .map((opening) => ({
                id: opening.id,
                kind: opening.active ? opening.kind : "ignore",
              }))),
            manualWalls: state.walls
              .filter((wall) => wall.manual)
              .map(({ id, start, end, thickness, active }) => ({
                id,
                start,
                end,
                thickness,
                active,
              })),
            manualOpenings: state.walls.flatMap((wall) => wall.openings
              .filter((opening) => opening.manual)
              .map(({ id, startOffset, endOffset, kind, active }) => ({
                id,
                wallId: wall.id,
                startOffset,
                endOffset,
                kind,
                active,
              }))),
          },
        }),
      })
      await readEvents(response)
    } catch (error) {
      setState((current) => ({ ...current, status: "error", message: error.message }))
    }
  }

  const selectedPreset = presets.find((preset) => preset.id === selectedPresetId)

  return (
    <main className="workspace">
      <SiteHeader active="workspace" />

      <section className="intro">
        <div>
          <p className="eyebrow">DRAWING OPERATIONS / 排板工作台</p>
          <h1>
            上传图纸，
            <br />
            交给规则或 AI。
          </h1>
          <p className="lede">从 CAD 图纸恢复墙体，完成墙板与吊顶排版，并在同一处取回图纸和材料清单。</p>
        </div>
        <div className="blueprint" aria-hidden="true">
          <span className="bp-code">W-014</span>
          <span className="bp-measure">1180 + 3 + 1180</span>
          <i className="wall wall-a" />
          <i className="wall wall-b" />
          <i className="joint joint-a" />
          <i className="joint joint-b" />
        </div>
      </section>

      <section className="console">
        <div className="step">
          <div className="step-heading">
            <span>01</span>
            <div>
              <h2>选择图纸</h2>
              <p>支持 DXF、DWG，单个文件最大 100 MB</p>
            </div>
          </div>
          <label
            className={`upload ${cadFile ? "has-file" : ""} ${dragging ? "is-dragging" : ""}`}
            onDragEnter={() => setDragging(true)}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault()
              setDragging(false)
              selectCad(event.dataTransfer.files[0])
            }}
          >
            <input
              type="file"
              accept=".dxf,.dwg"
              onChange={(event) => selectCad(event.target.files[0])}
            />
            <span className="upload-plus">{cadFile ? "✓" : "+"}</span>
            <span>
              <strong>{dragging ? "松开即可选择图纸" : cadFile?.name || "点击选择或拖入 CAD 图纸"}</strong>
              <small>{cadFile ? formatSize(cadFile.size) : "DXF / DWG · 文件只用于本次转换任务"}</small>
            </span>
          </label>
        </div>

        <div className="step">
          <div className="step-heading">
            <span>02</span>
            <div>
              <h2>选择预设</h2>
              <p>识别、门窗和材料排板统一使用同一套参数</p>
            </div>
          </div>
          <div className="preset-picker">
            <select
              value={selectedPresetId}
              onChange={(event) => setSelectedPresetId(event.target.value)}
              disabled={!presets.length}
              aria-label="设置预设"
            >
              {!presets.length && <option>{presetError || "正在读取预设…"}</option>}
              {presets.map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.name}</option>
              ))}
            </select>
            <a href="/settings">管理预设 ↗</a>
            {selectedPreset && (
              <p>
                墙厚 {selectedPreset.drawing.wall_thicknesses.join(" / ")} mm
                <span>墙板 {selectedPreset.materials.primary_width} · 吊顶 {selectedPreset.ceiling.panel_width} mm</span>
              </p>
            )}
          </div>
        </div>

        <div className="step action-step">
          <div className="step-heading">
            <span>03</span>
            <div>
              <h2>开始转换</h2>
              <p>AI 负责语义判断，本地模式只使用几何规则</p>
            </div>
          </div>
          <div className="actions">
            <button
              className="primary-action"
              type="button"
              disabled={!selectedPresetId || ["detecting", "review", "converting"].includes(state.status)}
              onClick={() => convert("ai")}
            >
              <span>AI 转换</span>
              <small>使用所选预设和 .env 模型配置</small>
            </button>
            <button
              className="secondary-action"
              type="button"
              disabled={!selectedPresetId || ["detecting", "review", "converting"].includes(state.status)}
              onClick={() => convert("local")}
            >
              <span>本地转换</span>
              <small>不调用外部模型</small>
            </button>
          </div>
        </div>
      </section>

      <section className={`result result-${state.status}`} aria-live="polite">
        {state.status === "idle" && (
          <>
            <span className="result-index">OUTPUT</span>
            <p>转换结果会出现在这里。</p>
          </>
        )}
        {(state.status === "detecting" || state.status === "converting") && (
          <>
            <span className="spinner" />
            <div>
              <strong>
                {state.status === "detecting"
                  ? state.mode === "ai" ? "AI 正在识别墙体…" : "正在识别墙体…"
                  : "正在生成排版图和材料清单…"}
              </strong>
              <p>复杂图纸可能需要几分钟，请保持当前页面打开。</p>
            </div>
          </>
        )}
        {state.status === "review" && (
          <div className="review">
            <div className="review-heading">
              <div>
                <strong>请确认墙体识别结果</strong>
                <p>当前预设：{state.presetName}。确认后继续生成墙板、吊顶排版图和材料清单。</p>
              </div>
              <div className="review-actions">
                <button type="button" onClick={() => setState({ status: "idle" })}>返回重选</button>
                <button type="button" onClick={confirmWalls}>确认并继续</button>
              </div>
            </div>
            <CadReview
              walls={state.walls}
              entityMap={state.entityMap}
              reviewUrl={state.reviewUrl}
              onChange={(walls) => setState((current) => ({ ...current, walls }))}
            />
          </div>
        )}
        {state.status === "error" && (
          <>
            <span className="error-mark">!</span>
            <div>
              <strong>转换未完成</strong>
              <p>{state.message}</p>
            </div>
          </>
        )}
        {state.status === "success" && (
          <>
            <div className="result-title">
              <span className="success-mark">✓</span>
              <div>
                <strong>{state.mode === "ai" ? "AI 转换完成" : "本地转换完成"}</strong>
                <p>任务 {state.job.slice(0, 8)} · {state.presetName}</p>
              </div>
            </div>
            <div className="downloads">
              {state.files.map((file) => (
                <a key={file.name} href={file.url}>
                  <span>{FILE_LABELS[file.name] || file.name}</span>
                  <small>{file.name}</small>
                  <b>下载 ↓</b>
                </a>
              ))}
            </div>
          </>
        )}
        {state.logs?.length > 0 && (
          <ol className="progress-log">
            {state.logs.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ol>
        )}
      </section>

      <footer>
        <span>CAD MASTER / LOCAL WORKSPACE</span>
        <span>图纸与结果保存在当前项目的 data/jobs 目录</span>
      </footer>
    </main>
  )
}
