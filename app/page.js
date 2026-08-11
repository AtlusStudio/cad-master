"use client"

import { useEffect, useState } from "react"
import {
  ArrowRight,
  ArrowLeft,
  Check,
  CheckCircle2,
  CircleAlert,
  Cpu,
  Download,
  FileOutput,
  LoaderCircle,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from "lucide-react"

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
    <div className="min-h-screen lg:flex">
      <SiteHeader active="workspace" />
      <main className="min-w-0 flex-1">
        <header className="flex min-h-[76px] items-center justify-between border-b border-slate-200 bg-white px-5 sm:px-8">
          <div>
            <p className="font-mono text-[9px] font-bold tracking-[.18em] text-[#ff6b2c]">DRAWING OPERATIONS</p>
            <h1 className="mt-1 text-xl font-bold tracking-tight">转换工作台</h1>
          </div>
          <div className="hidden items-center gap-3 text-right sm:flex">
            <div><strong className="block text-xs">新建排板任务</strong><small className="text-[10px] text-slate-400">DXF / DWG → 墙板与吊顶</small></div>
            <span className="grid size-9 place-items-center rounded-full bg-slate-100 font-mono text-[10px] font-bold text-slate-500">OP</span>
          </div>
        </header>

        <div className="mx-auto max-w-[1500px] p-4 sm:p-8">
          <section className="relative overflow-hidden bg-[#153b5b] px-6 py-7 text-white shadow-[0_18px_50px_rgba(15,23,42,.12)] sm:px-9 sm:py-9">
            <div className="absolute inset-0 opacity-20 [background-image:linear-gradient(rgba(255,255,255,.18)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.18)_1px,transparent_1px)] [background-size:24px_24px]" aria-hidden="true" />
            <div className="relative max-w-2xl">
              <span className="font-mono text-[10px] tracking-[.18em] text-sky-200">CAD MASTER / NEW JOB</span>
              <h2 className="mt-4 text-3xl font-bold tracking-[-.04em] sm:text-4xl">从一张图纸，开始完整排板。</h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-sky-100/70">识别墙体与门窗，校正确认后自动生成墙板、吊顶排版图和材料清单。</p>
            </div>
            <div className="absolute bottom-5 right-7 hidden font-mono text-[9px] tracking-[.16em] text-sky-200/50 md:block">W-014 · 1180 + 3 + 1180</div>
          </section>

          <section className="mt-6 grid gap-4 xl:grid-cols-[1.1fr_.9fr_1fr]">
            <div className="border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex items-start gap-4">
                <span className="grid size-8 shrink-0 place-items-center bg-[#fff0e9] font-mono text-xs font-bold text-[#ff6b2c]">01</span>
                <div><h2 className="text-sm font-bold">选择图纸</h2><p className="mt-1 text-xs text-slate-400">DXF、DWG · 最大 100 MB</p></div>
              </div>
          <label
            className={`mt-5 flex min-h-36 cursor-pointer flex-col items-center justify-center border border-dashed p-5 text-center transition-colors focus-within:ring-2 focus-within:ring-[#ff6b2c] ${dragging ? "border-[#ff6b2c] bg-orange-50" : cadFile ? "border-emerald-300 bg-emerald-50/50" : "border-slate-300 bg-slate-50 hover:border-[#153b5b] hover:bg-sky-50/40"}`}
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
              className="sr-only"
              type="file"
              accept=".dxf,.dwg"
              onChange={(event) => selectCad(event.target.files[0])}
            />
            <span className={`grid size-10 place-items-center rounded-full ${cadFile ? "bg-emerald-500 text-white" : "bg-white text-[#153b5b] shadow-sm"}`}>
              {cadFile ? <Check className="size-5" aria-hidden="true" /> : <Upload className="size-5" aria-hidden="true" />}
            </span>
            <span className="mt-3 min-w-0">
              <strong className="block max-w-60 truncate text-sm">{dragging ? "松开即可选择图纸" : cadFile?.name || "点击选择或拖入图纸"}</strong>
              <small className="mt-1 block text-[10px] text-slate-400">{cadFile ? formatSize(cadFile.size) : "文件只用于本次转换任务"}</small>
            </span>
          </label>
        </div>

            <div className="border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex items-start gap-4">
                <span className="grid size-8 shrink-0 place-items-center bg-[#fff0e9] font-mono text-xs font-bold text-[#ff6b2c]">02</span>
                <div><h2 className="text-sm font-bold">选择参数预设</h2><p className="mt-1 text-xs text-slate-400">整条处理链共用一套规则</p></div>
              </div>
              <div className="mt-5">
            <select
              className="h-12 w-full border border-slate-300 bg-white px-3 text-sm font-semibold outline-none focus:border-[#153b5b] focus:ring-2 focus:ring-sky-100 disabled:text-slate-400"
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
                <div className="mt-3 flex justify-end"><a className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#153b5b] hover:text-[#ff6b2c]" href="/settings"><SlidersHorizontal className="size-3.5" aria-hidden="true" />管理预设</a></div>
            {selectedPreset && (
                  <dl className="mt-4 grid grid-cols-3 gap-px bg-slate-200 font-mono text-[9px]">
                    <div className="bg-slate-50 p-3"><dt className="text-slate-400">墙厚</dt><dd className="mt-1 font-bold text-slate-700">{selectedPreset.drawing.wall_thicknesses.join("/")}</dd></div>
                    <div className="bg-slate-50 p-3"><dt className="text-slate-400">墙板</dt><dd className="mt-1 font-bold text-slate-700">{selectedPreset.materials.primary_width}</dd></div>
                    <div className="bg-slate-50 p-3"><dt className="text-slate-400">吊顶</dt><dd className="mt-1 font-bold text-slate-700">{selectedPreset.ceiling.panel_width}</dd></div>
                  </dl>
            )}
              </div>
          </div>

            <div className="border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
              <div className="flex items-start gap-4">
                <span className="grid size-8 shrink-0 place-items-center bg-[#fff0e9] font-mono text-xs font-bold text-[#ff6b2c]">03</span>
                <div><h2 className="text-sm font-bold">启动任务</h2><p className="mt-1 text-xs text-slate-400">选择识别引擎</p></div>
          </div>
              <div className="mt-5 grid gap-2">
            <button
              className="flex min-h-16 items-center justify-between bg-[#ff6b2c] px-5 text-left text-white transition-colors hover:bg-[#e9551b] focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-300 disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              disabled={!selectedPresetId || ["detecting", "review", "converting"].includes(state.status)}
              onClick={() => convert("ai")}
            >
                  <span className="flex items-center gap-3"><Sparkles className="size-5" aria-hidden="true" /><span><strong className="block text-sm">AI 智能转换</strong><small className="mt-1 block text-[10px] text-orange-100">理解图纸语义，适合复杂图纸</small></span></span><ArrowRight className="size-4" aria-hidden="true" />
            </button>
            <button
              className="flex min-h-14 items-center justify-between border border-slate-300 px-5 text-left transition-colors hover:border-[#153b5b] hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-100 disabled:cursor-not-allowed disabled:opacity-40"
              type="button"
              disabled={!selectedPresetId || ["detecting", "review", "converting"].includes(state.status)}
              onClick={() => convert("local")}
            >
                  <span className="flex items-center gap-3"><Cpu className="size-4 text-slate-500" aria-hidden="true" /><span><strong className="block text-xs">本地规则转换</strong><small className="mt-1 block text-[9px] text-slate-400">不调用外部模型</small></span></span><ArrowRight className="size-4 text-slate-400" aria-hidden="true" />
            </button>
              </div>
          </div>
          </section>

          <section className="mt-6 border border-slate-200 bg-white shadow-sm" aria-live="polite">
            <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4 sm:px-6"><div><h2 className="text-sm font-bold">任务输出</h2><p className="mt-1 text-[10px] text-slate-400">状态、复核与文件下载</p></div><span className="font-mono text-[9px] tracking-[.14em] text-slate-400">OUTPUT</span></div>
            <div className="p-5 sm:p-6">
        {state.status === "idle" && (
                <div className="grid min-h-28 place-items-center border border-dashed border-slate-200 bg-slate-50 text-center"><div><FileOutput className="mx-auto size-6 text-slate-300" strokeWidth={1.6} aria-hidden="true" /><p className="mt-2 text-xs text-slate-400">完成上方三步后，转换结果会出现在这里</p></div></div>
        )}
        {(state.status === "detecting" || state.status === "converting") && (
                <div className="flex min-h-28 items-center gap-4 bg-sky-50 p-5">
                  <LoaderCircle className="size-6 animate-spin text-[#153b5b] motion-reduce:animate-none" aria-hidden="true" />
            <div>
                    <strong className="text-sm">
                {state.status === "detecting"
                  ? state.mode === "ai" ? "AI 正在识别墙体…" : "正在识别墙体…"
                  : "正在生成排版图和材料清单…"}
              </strong>
                    <p className="mt-1 text-xs text-slate-500">复杂图纸可能需要几分钟，请保持当前页面打开。</p>
            </div>
                </div>
        )}
        {state.status === "review" && (
                <div>
                  <div className="mb-5 flex flex-col gap-4 border-l-4 border-amber-400 bg-amber-50 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                      <strong className="text-sm">请确认墙体识别结果</strong>
                      <p className="mt-1 text-xs text-slate-500">当前预设：{state.presetName}。确认后继续生成排版图和材料清单。</p>
              </div>
                    <div className="flex gap-2"><button className="inline-flex items-center gap-1.5 border border-slate-300 bg-white px-4 py-2 text-xs font-semibold hover:bg-slate-50" type="button" onClick={() => setState({ status: "idle" })}><ArrowLeft className="size-3.5" aria-hidden="true" />返回重选</button><button className="inline-flex items-center gap-1.5 bg-[#ff6b2c] px-4 py-2 text-xs font-semibold text-white hover:bg-[#e9551b]" type="button" onClick={confirmWalls}><Check className="size-3.5" aria-hidden="true" />确认并继续</button></div>
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
                <div className="flex min-h-28 items-center gap-4 border-l-4 border-red-500 bg-red-50 p-5"><CircleAlert className="size-8 text-red-500" aria-hidden="true" />
            <div>
                    <strong className="text-sm text-red-900">转换未完成</strong><p className="mt-1 text-xs text-red-700">{state.message}</p>
            </div>
                </div>
        )}
        {state.status === "success" && (
                <div>
                  <div className="flex items-center gap-3 bg-emerald-50 p-4"><CheckCircle2 className="size-8 text-emerald-500" aria-hidden="true" />
              <div>
                      <strong className="text-sm text-emerald-900">{state.mode === "ai" ? "AI 转换完成" : "本地转换完成"}</strong><p className="mt-1 font-mono text-[10px] text-emerald-700">任务 {state.job.slice(0, 8)} · {state.presetName}</p>
              </div>
            </div>
                  <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {state.files.map((file) => (
                      <a className="group flex items-center justify-between border border-slate-200 p-4 hover:border-[#153b5b] hover:bg-slate-50" key={file.name} href={file.url}>
                        <span><strong className="block text-xs">{FILE_LABELS[file.name] || file.name}</strong><small className="mt-1 block font-mono text-[9px] text-slate-400">{file.name}</small></span><span className="flex items-center gap-1 text-xs font-bold text-[#153b5b] group-hover:text-[#ff6b2c]">下载<Download className="size-3.5" aria-hidden="true" /></span>
                </a>
              ))}
            </div>
                </div>
        )}
        {state.logs?.length > 0 && (
                <ol className="mt-4 space-y-1 border-t border-slate-100 pt-4 font-mono text-[10px] text-slate-500">
            {state.logs.map((line) => (
                    <li className="before:mr-2 before:text-emerald-500 before:content-['✓']" key={line}>{line}</li>
            ))}
          </ol>
        )}
            </div>
          </section>
          <footer className="flex flex-col justify-between gap-2 py-6 font-mono text-[9px] tracking-[.1em] text-slate-400 sm:flex-row"><span>CAD MASTER / LOCAL WORKSPACE</span><span>图纸与结果保存在 data/jobs</span></footer>
        </div>
      </main>
    </div>
  )
}
