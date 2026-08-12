"use client"

import { useEffect, useRef, useState } from "react"
import { Download, LoaderCircle } from "lucide-react"

export default function CadResultViewer({ files }) {
  const drawings = files.filter((file) => file.name.endsWith(".dxf"))
  const [selectedName, setSelectedName] = useState(drawings[0]?.name || "")
  const [viewerState, setViewerState] = useState("loading")
  const containerRef = useRef(null)
  const selected = drawings.find((file) => file.name === selectedName) || drawings[0]

  useEffect(() => {
    if (!selected) return
    let cancelled = false
    let manager

    async function openViewer() {
      setViewerState("loading")
      try {
        const cad = await import("@mlightcad/cad-simple-viewer")
        if (cancelled) return
        manager = cad.AcApDocManager.createInstance({
          container: containerRef.current,
          autoResize: true,
          builtinOpenFileDialog: false,
          notLoadDefaultFonts: true,
          webworkerFileUrls: {
            dxfParser: "/api/cad-workers/dxf-parser-worker.js",
            mtextRender: "/api/cad-workers/mtext-renderer-worker.js",
          },
        })
        const response = await fetch(selected.url)
        if (!response.ok) throw new Error("无法读取生成的 CAD 图纸")
        const opened = await manager.openDocument(selected.name, await response.arrayBuffer(), {
          mode: cad.AcEdOpenMode.Read,
          openViewMode: cad.AcApOpenViewMode.Extents,
          progressiveRendering: true,
        })
        if (!opened) throw new Error("CAD 查看器无法打开图纸")
        if (!cancelled) setViewerState("ready")
      } catch (error) {
        if (!cancelled) setViewerState(error.message)
      }
    }

    openViewer()
    return () => {
      cancelled = true
      if (manager) void manager.destroy()
    }
  }, [selected])

  if (!selected) return null

  return (
    <div className="overflow-hidden border border-slate-200 bg-white shadow-sm">
      <div className="flex flex-col gap-3 border-b border-slate-200 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <span className="font-mono text-[9px] font-bold tracking-[.16em] text-[#ff6b2c]">CAD VIEWER</span>
          {drawings.length > 1 && (
            <select
              className="h-9 border border-slate-300 bg-white px-3 text-xs font-semibold outline-none focus:border-[#153b5b]"
              value={selected.name}
              onChange={(event) => setSelectedName(event.target.value)}
              aria-label="选择预览图纸"
            >
              {drawings.map((file) => <option key={file.name} value={file.name}>{file.name}</option>)}
            </select>
          )}
        </div>
        <a className="inline-flex h-9 items-center justify-center gap-2 bg-[#ff6b2c] px-4 text-xs font-bold text-white hover:bg-[#e9551b]" href={selected.url} download>
          <Download className="size-3.5" aria-hidden="true" />下载当前图纸
        </a>
      </div>
      <div className="relative h-[520px] min-h-[360px] bg-[#08111b] lg:h-[640px]">
        <div ref={containerRef} className="size-full" />
        {viewerState !== "ready" && (
          <div className="absolute inset-0 grid place-items-center bg-[#08111b] font-mono text-xs text-slate-400">
            <span className="flex items-center gap-2">
              {viewerState === "loading" && <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
              {viewerState === "loading" ? "正在载入生成结果…" : viewerState}
            </span>
          </div>
        )}
      </div>
      <p className="bg-[#111923] px-4 py-2 font-mono text-[9px] text-slate-500">滚轮缩放 · 中键拖动平移</p>
    </div>
  )
}
