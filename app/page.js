"use client"

import { useEffect, useRef, useState } from "react"

const FILE_LABELS = {
  "panel_layout_result.dxf": "墙板排版图",
  "ceiling_panel_layout_result.dxf": "吊顶排版图",
  "detected_walls.dxf": "墙体识别图",
  "panel_schedule.csv": "材料清单 CSV",
  "panel_schedule.json": "材料清单 JSON",
  "detected_model.json": "识别模型",
  "ai_recognition.json": "AI 原始结果",
}

function formatSize(size) {
  if (size < 1024 * 1024) return `${Math.ceil(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

const PREVIEW_COLORS = {
  wall: "#2878b8",
  door: "#ff6b35",
  window: "#32a66b",
}

function WallPreview({ walls }) {
  const canvasRef = useRef(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const context = canvas.getContext("2d")
    const points = walls.flatMap((wall) => [wall.start, wall.end])
    const xs = points.map(([x]) => x)
    const ys = points.map(([, y]) => y)
    const bounds = {
      minX: Math.min(...xs),
      maxX: Math.max(...xs),
      minY: Math.min(...ys),
      maxY: Math.max(...ys),
    }
    const padding = 50
    const scale = Math.min(
      (canvas.width - padding * 2) / Math.max(bounds.maxX - bounds.minX, 1),
      (canvas.height - padding * 2) / Math.max(bounds.maxY - bounds.minY, 1),
    )
    const point = ([x, y]) => [
      padding + (x - bounds.minX) * scale,
      canvas.height - padding - (y - bounds.minY) * scale,
    ]

    context.clearRect(0, 0, canvas.width, canvas.height)
    context.lineCap = "butt"
    for (const wall of walls) {
      const [startX, startY] = point(wall.start)
      const [endX, endY] = point(wall.end)
      const length = Math.hypot(endX - startX, endY - startY)
      const lineWidth = Math.max(4, wall.thickness * scale)
      context.strokeStyle = PREVIEW_COLORS.wall
      context.lineWidth = lineWidth
      context.beginPath()
      context.moveTo(startX, startY)
      context.lineTo(endX, endY)
      context.stroke()

      for (const opening of wall.openings) {
        const from = opening.startOffset * scale / length
        const to = opening.endOffset * scale / length
        context.strokeStyle = PREVIEW_COLORS[opening.kind] || PREVIEW_COLORS.wall
        context.lineWidth = lineWidth + 2
        context.beginPath()
        context.moveTo(
          startX + (endX - startX) * from,
          startY + (endY - startY) * from,
        )
        context.lineTo(
          startX + (endX - startX) * to,
          startY + (endY - startY) * to,
        )
        context.stroke()
      }
    }
  }, [walls])

  const openings = walls.flatMap((wall) => wall.openings)
  return (
    <div className="wall-preview">
      <canvas ref={canvasRef} width="1200" height="680">
        当前浏览器不支持 Canvas 预览。
      </canvas>
      <div className="preview-summary">
        <span><i style={{ background: PREVIEW_COLORS.wall }} />墙面 {walls.length}</span>
        <span><i style={{ background: PREVIEW_COLORS.door }} />门 {openings.filter((item) => item.kind === "door").length}</span>
        <span><i style={{ background: PREVIEW_COLORS.window }} />窗 {openings.filter((item) => item.kind === "window").length}</span>
      </div>
    </div>
  )
}

export default function Home() {
  const [cadFile, setCadFile] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [materialsFile, setMaterialsFile] = useState(null)
  const [state, setState] = useState({ status: "idle" })

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

    const data = new FormData()
    data.append("cad", cadFile)
    if (materialsFile) data.append("materials", materialsFile)
    data.append("mode", mode)
    setState({ status: "detecting", mode, logs: [] })

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
          setState((current) => ({ status: "review", logs: current.logs, ...event }))
        } else if (event.type === "done") {
          setState((current) => ({ status: "success", logs: current.logs, ...event }))
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
        body: JSON.stringify({ action: "confirm", job: state.job }),
      })
      await readEvents(response)
    } catch (error) {
      setState((current) => ({ ...current, status: "error", message: error.message }))
    }
  }

  return (
    <main className="workspace">
      <header className="topbar">
        <a className="brand" href="/" aria-label="CAD Master 首页">
          <span className="brand-mark">CM</span>
          <span>
            <strong>CAD Master</strong>
            <small>洁净室自动排板</small>
          </span>
        </a>
        <div className="system-state">
          <span />
          本地处理服务
        </div>
      </header>

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
              <h2>材料参数</h2>
              <p>可选；不上传时使用项目默认配置</p>
            </div>
          </div>
          <label className="compact-upload">
            <input
              type="file"
              accept=".json,application/json"
              onChange={(event) => setMaterialsFile(event.target.files[0] || null)}
            />
            <span>{materialsFile?.name || "选择 materials.json"}</span>
            <b>{materialsFile ? "更换" : "浏览"}</b>
          </label>
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
              disabled={["detecting", "review", "converting"].includes(state.status)}
              onClick={() => convert("ai")}
            >
              <span>AI 转换</span>
              <small>使用 .env 中的模型配置</small>
            </button>
            <button
              className="secondary-action"
              type="button"
              disabled={["detecting", "review", "converting"].includes(state.status)}
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
                <p>确认后才会继续生成墙板、吊顶排版图和材料清单。</p>
              </div>
              <div className="review-actions">
                <button type="button" onClick={() => setState({ status: "idle" })}>返回重选</button>
                <button type="button" onClick={confirmWalls}>确认并继续</button>
              </div>
            </div>
            <WallPreview walls={state.walls} />
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
                <p>任务 {state.job.slice(0, 8)}</p>
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
        <span>图纸与结果保存在当前项目的 output 目录</span>
      </footer>
    </main>
  )
}
