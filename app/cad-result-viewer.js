"use client"

import { useEffect, useRef, useState } from "react"
import { LoaderCircle } from "lucide-react"

export default function CadResultViewer({ files }) {
  const selected = files.find((file) => file.name.endsWith(".dxf"))
  const [viewerState, setViewerState] = useState("loading")
  const containerRef = useRef(null)

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
