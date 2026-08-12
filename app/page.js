"use client"

import { useEffect, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Download,
  FileOutput,
  LoaderCircle,
  Sparkles,
  Upload,
} from "lucide-react"

import CadResultViewer from "./cad-result-viewer"
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
      .then((result) => setSelectedPresetId(result.defaultPresetId || result.presets[0]?.id || ""))
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
    if (!selectedPresetId) {
      setState({ status: "error", message: presetError || "没有可用的默认参数预设。" })
      return
    }

    const data = new FormData()
    data.append("cad", cadFile)
    data.append("mode", mode)
    data.append("presetId", selectedPresetId)
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
              .map((opening) => ({ id: opening.id, kind: opening.active ? opening.kind : "ignore" }))),
            manualWalls: state.walls
              .filter((wall) => wall.manual)
              .map(({ id, start, end, thickness, active }) => ({ id, start, end, thickness, active })),
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

  const step = state.status === "success" ? 3 : state.walls ? 2 : 1

  return (
    <div className="min-h-screen lg:flex">
      <SiteHeader active="workspace" />
      <main className="min-w-0 flex-1">
        <header className="flex min-h-[76px] items-center justify-between border-b border-slate-200 bg-white px-5 sm:px-8">
          <div>
            <p className="font-mono text-[9px] font-bold tracking-[.18em] text-[#ff6b2c]">DRAWING OPERATIONS</p>
            <h1 className="mt-1 text-xl font-bold tracking-tight">转换工作台</h1>
          </div>
          <ol className="hidden items-center gap-2 md:flex" aria-label="转换进度">
            {["上传图纸", "调整墙门窗", "查看结果"].map((label, index) => {
              const number = index + 1
              return (
                <li className={`flex items-center gap-2 text-xs font-semibold ${number === step ? "text-[#153b5b]" : number < step ? "text-emerald-600" : "text-slate-300"}`} key={label}>
                  <span className={`grid size-7 place-items-center font-mono text-[10px] ${number === step ? "bg-[#ff6b2c] text-white" : number < step ? "bg-emerald-100" : "bg-slate-100"}`}>
                    {number < step ? <Check className="size-3.5" aria-hidden="true" /> : number}
                  </span>
                  {label}{number < 3 && <ArrowRight className="ml-2 size-3 text-slate-300" aria-hidden="true" />}
                </li>
              )
            })}
          </ol>
        </header>

        <div className="mx-auto max-w-[1500px] p-4 sm:p-8">
          {step === 1 && (
            <section className="mx-auto max-w-3xl py-4 sm:py-10">
              <div className="mb-7">
                <span className="font-mono text-[10px] font-bold tracking-[.18em] text-[#ff6b2c]">STEP 01 / 03</span>
                <h2 className="mt-3 text-3xl font-bold tracking-[-.04em] sm:text-4xl">上传一张待处理图纸</h2>
                <p className="mt-3 text-sm text-slate-500">系统会使用默认项目参数识别墙体、门和窗。</p>
              </div>

              <label
                className={`flex min-h-[360px] cursor-pointer flex-col items-center justify-center border-2 border-dashed bg-white p-8 text-center shadow-sm transition-colors focus-within:ring-2 focus-within:ring-[#ff6b2c] ${dragging ? "border-[#ff6b2c] bg-orange-50" : cadFile ? "border-emerald-400" : "border-slate-300 hover:border-[#153b5b]"}`}
                onDragEnter={() => setDragging(true)}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragging(false)
                  selectCad(event.dataTransfer.files[0])
                }}
              >
                <input className="sr-only" type="file" accept=".dxf,.dwg" onChange={(event) => selectCad(event.target.files[0])} />
                <span className={`grid size-16 place-items-center rounded-full ${cadFile ? "bg-emerald-500 text-white" : "bg-sky-50 text-[#153b5b]"}`}>
                  {cadFile ? <Check className="size-7" aria-hidden="true" /> : <Upload className="size-7" aria-hidden="true" />}
                </span>
                <strong className="mt-5 block max-w-md truncate text-lg">{dragging ? "松开即可上传" : cadFile?.name || "点击选择或拖入图纸"}</strong>
                <small className="mt-2 text-xs text-slate-400">{cadFile ? `${formatSize(cadFile.size)} · DXF / DWG` : "支持 DXF、DWG，最大 100 MB"}</small>
              </label>

              {state.status === "error" && (
                <div className="mt-4 flex items-center gap-3 border-l-4 border-red-500 bg-red-50 p-4 text-sm text-red-800">
                  <CircleAlert className="size-5 shrink-0" aria-hidden="true" />{state.message}
                </div>
              )}
              {state.status === "detecting" ? (
                <div className="mt-5 flex items-center justify-center gap-3 bg-[#153b5b] px-5 py-4 text-sm font-bold text-white">
                  <LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  {state.mode === "ai" ? "AI 正在识别墙体与门窗…" : "本地规则正在识别墙体与门窗…"}
                </div>
              ) : (
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  <button className="flex items-center justify-between bg-[#ff6b2c] px-5 py-4 text-left text-white hover:bg-[#e9551b] disabled:cursor-not-allowed disabled:opacity-40" type="button" disabled={!cadFile} onClick={() => convert("ai")}>
                    <span className="flex items-center gap-3"><Sparkles className="size-5" aria-hidden="true" /><span><strong className="block text-sm">AI 智能识别</strong><small className="mt-1 block text-[10px] text-orange-100">适合复杂图纸</small></span></span><ArrowRight className="size-4" aria-hidden="true" />
                  </button>
                  <button className="flex items-center justify-between border border-slate-300 bg-white px-5 py-4 text-left hover:border-[#153b5b] hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40" type="button" disabled={!cadFile} onClick={() => convert("local")}>
                    <span className="flex items-center gap-3"><Cpu className="size-5 text-[#153b5b]" aria-hidden="true" /><span><strong className="block text-sm">本地规则识别</strong><small className="mt-1 block text-[10px] text-slate-400">不调用外部模型</small></span></span><ArrowRight className="size-4 text-slate-400" aria-hidden="true" />
                  </button>
                </div>
              )}
            </section>
          )}

          {step === 2 && (
            <section>
              <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <span className="font-mono text-[10px] font-bold tracking-[.18em] text-[#ff6b2c]">STEP 02 / 03</span>
                  <h2 className="mt-2 text-2xl font-bold tracking-[-.03em]">调整墙体、门和窗</h2>
                  <p className="mt-2 text-xs text-slate-500">选择识别对象修改类型，也可以直接补画缺失内容。</p>
                </div>
                {state.status === "review" && (
                  <div className="flex gap-2">
                    <button className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold hover:bg-slate-50" type="button" onClick={() => setState({ status: "idle" })}><ArrowLeft className="size-3.5" aria-hidden="true" />重新上传</button>
                    <button className="inline-flex items-center gap-1.5 bg-[#ff6b2c] px-5 py-2.5 text-xs font-bold text-white hover:bg-[#e9551b]" type="button" onClick={confirmWalls}><Check className="size-3.5" aria-hidden="true" />确认并生成</button>
                  </div>
                )}
              </div>

              {state.status === "converting" ? (
                <div className="grid min-h-[560px] place-items-center border border-slate-200 bg-white text-center shadow-sm">
                  <div><LoaderCircle className="mx-auto size-9 animate-spin text-[#ff6b2c] motion-reduce:animate-none" aria-hidden="true" /><strong className="mt-4 block text-sm">正在生成 CAD 排版结果…</strong><p className="mt-2 text-xs text-slate-400">请保持当前页面打开</p></div>
                </div>
              ) : (
                <>
                  {state.status === "error" && (
                    <div className="mb-4 flex items-center justify-between gap-4 border-l-4 border-red-500 bg-red-50 p-4 text-sm text-red-800">
                      <span className="flex items-center gap-2"><CircleAlert className="size-5 shrink-0" aria-hidden="true" />{state.message}</span>
                      <button className="shrink-0 font-bold" type="button" onClick={() => setState((current) => ({ ...current, status: "review" }))}>返回调整</button>
                    </div>
                  )}
                  <CadReview walls={state.walls} entityMap={state.entityMap} reviewUrl={state.reviewUrl} onChange={(walls) => setState((current) => ({ ...current, walls }))} />
                </>
              )}
            </section>
          )}

          {step === 3 && (
            <section>
              <div className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <span className="font-mono text-[10px] font-bold tracking-[.18em] text-emerald-600">STEP 03 / 03 · COMPLETED</span>
                  <h2 className="mt-2 text-2xl font-bold tracking-[-.03em]">查看生成的 CAD 结果</h2>
                  <p className="mt-2 text-xs text-slate-500">任务 {state.job.slice(0, 8)} · {state.presetName}</p>
                </div>
                <button className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold hover:bg-slate-50" type="button" onClick={() => { setCadFile(null); setState({ status: "idle" }) }}><FileOutput className="size-3.5" aria-hidden="true" />新建任务</button>
              </div>

              <div className="mb-4 flex items-center gap-3 bg-emerald-50 p-4"><CheckCircle2 className="size-7 text-emerald-500" aria-hidden="true" /><strong className="text-sm text-emerald-900">排版图和材料清单已生成</strong></div>
              <CadResultViewer files={state.files} />

              <div className="mt-5 border border-slate-200 bg-white shadow-sm">
                <div className="border-b border-slate-200 px-5 py-4"><h3 className="text-sm font-bold">下载全部结果</h3></div>
                <div className="grid gap-px bg-slate-200 sm:grid-cols-2 xl:grid-cols-3">
                  {state.files.map((file) => (
                    <a className="group flex items-center justify-between bg-white p-4 hover:bg-slate-50" key={file.name} href={file.url} download>
                      <span><strong className="block text-xs">{FILE_LABELS[file.name] || file.name}</strong><small className="mt-1 block font-mono text-[9px] text-slate-400">{file.name}</small></span>
                      <Download className="size-4 text-[#153b5b] group-hover:text-[#ff6b2c]" aria-hidden="true" />
                    </a>
                  ))}
                </div>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}
