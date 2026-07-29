"use client"

import { useEffect, useRef, useState } from "react"

const REVIEW_LAYERS = {
  wall: "CADMASTER_REVIEW_WALL",
  door: "CADMASTER_REVIEW_DOOR",
  window: "CADMASTER_REVIEW_WINDOW",
  ignore: "CADMASTER_REVIEW_IGNORE",
}

export default function CadReview({ walls, entityMap, reviewUrl, onChange }) {
  const containerRef = useRef(null)
  const managerRef = useRef(null)
  const wallsRef = useRef(walls)
  const originalWallsRef = useRef(walls)
  const historyRef = useRef([])
  const [selection, setSelection] = useState(null)
  const [viewerState, setViewerState] = useState("loading")

  function handlesFor(item) {
    return Object.entries(entityMap)
      .filter(([, value]) => value.type === item.type && value.id === item.id)
      .map(([handle]) => handle)
  }

  function selectItem(item) {
    setSelection(item)
    const selectionSet = managerRef.current?.curView.selectionSet
    if (!selectionSet) return
    selectionSet.clear()
    selectionSet.add(handlesFor(item))
  }

  function applyColors(manager, currentWalls) {
    const byWall = new Map(currentWalls.map((wall) => [wall.id, wall]))
    manager.curDocument.entityService.runEdit("人工校正", () => {
      for (const [handle, item] of Object.entries(entityMap)) {
        const wall = byWall.get(item.wallId)
        const opening = item.type === "opening"
          ? wall?.openings.find((value) => value.id === item.id)
          : null
        const layer = item.type === "wall"
          ? wall?.active ? REVIEW_LAYERS.wall : REVIEW_LAYERS.ignore
          : wall?.active && opening?.active
            ? REVIEW_LAYERS[opening.kind]
            : REVIEW_LAYERS.ignore
        const entity = manager.curDocument.database.openObjectForWrite(handle)
        if (entity && entity.layer !== layer) entity.layer = layer
      }
    })
  }

  useEffect(() => {
    let cancelled = false
    let manager
    let selectionListener

    async function openViewer() {
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
        managerRef.current = manager

        const response = await fetch(reviewUrl)
        if (!response.ok) throw new Error("无法读取 CAD 复核图")
        const opened = await manager.openDocument(
          "review_candidates.dxf",
          await response.arrayBuffer(),
          {
            mode: cad.AcEdOpenMode.Write,
            openViewMode: cad.AcApOpenViewMode.Extents,
            progressiveRendering: true,
          },
        )
        if (!opened) throw new Error("CAD 查看器无法打开复核图")
        if (cancelled) return

        manager.curView.mode = cad.AcEdViewMode.SELECTION
        manager.curView.selectionBoxSize = 10
        let syncingSelection = false
        selectionListener = ({ ids }) => {
          if (syncingSelection) return
          const selected = ids.map((id) => entityMap[id]).find(Boolean)
          syncingSelection = true
          manager.curView.selectionSet.clear()
          if (selected) {
            manager.curView.selectionSet.add(handlesFor(selected))
            setSelection(selected)
          } else {
            setSelection(null)
          }
          syncingSelection = false
        }
        manager.curView.selectionSet.events.selectionAdded.addEventListener(selectionListener)
        applyColors(manager, wallsRef.current)
        setViewerState("ready")
      } catch (error) {
        if (!cancelled) setViewerState(error.message)
      }
    }

    openViewer()
    return () => {
      cancelled = true
      if (selectionListener) {
        manager?.curView.selectionSet.events.selectionAdded.removeEventListener(selectionListener)
      }
      managerRef.current = null
      if (manager) void manager.destroy()
    }
  }, [entityMap, reviewUrl])

  useEffect(() => {
    wallsRef.current = walls
    if (managerRef.current && viewerState === "ready") {
      applyColors(managerRef.current, walls)
    }
  }, [walls, viewerState])

  function classify(kind) {
    historyRef.current.push(walls)
    onChange(walls.map((wall) => {
      if (selection.type === "wall") {
        return wall.id === selection.id ? { ...wall, active: kind === "wall" } : wall
      }
      if (wall.id !== selection.wallId) return wall
      return {
        ...wall,
        active: kind === "ignore" ? wall.active : true,
        openings: wall.openings.map((opening) => (
          opening.id === selection.id
            ? { ...opening, active: kind !== "ignore", kind: kind === "ignore" ? opening.kind : kind }
            : opening
        )),
      }
    }))
  }

  function undo() {
    const previous = historyRef.current.pop()
    if (previous) onChange(previous)
  }

  function reset() {
    historyRef.current = []
    setSelection(null)
    managerRef.current?.curView.selectionSet.clear()
    onChange(originalWallsRef.current)
  }

  const activeOpenings = walls
    .filter((wall) => wall.active)
    .flatMap((wall) => wall.openings.filter((opening) => opening.active))

  return (
    <div className="wall-preview">
      <div className="cad-viewer-shell">
        <div
          ref={containerRef}
          className="cad-viewer"
          tabIndex="0"
          onKeyDown={(event) => {
            if (event.key === "Delete" || event.key === "Backspace") event.preventDefault()
          }}
        />
        {viewerState !== "ready" && (
          <div className="cad-viewer-state">
            {viewerState === "loading" ? "正在载入 CAD 查看器…" : viewerState}
          </div>
        )}
      </div>
      <p className="cad-viewer-help">滚轮缩放 · 中键拖动平移 · 单击或框选候选</p>
      <div className="candidate-editor">
        <label>
          <span>当前候选</span>
          <select
            value={selection ? `${selection.type}:${selection.id}` : ""}
            onChange={(event) => {
              const [type, id] = event.target.value.split(":")
              const wall = type === "wall"
                ? walls.find((item) => item.id === id)
                : walls.find((item) => item.openings.some((opening) => opening.id === id))
              if (wall) selectItem({ type, id, wallId: wall.id })
              else setSelection(null)
            }}
          >
            <option value="">点击图形或选择候选</option>
            {walls.map((wall) => (
              <option key={wall.id} value={`wall:${wall.id}`}>墙段 {wall.id}</option>
            ))}
            {walls.flatMap((wall) => wall.openings.map((opening) => (
              <option key={opening.id} value={`opening:${opening.id}`}>
                洞口 {opening.id} / 所属 {wall.id}
              </option>
            )))}
          </select>
        </label>
        {selection?.type === "wall" && (
          <div className="candidate-actions">
            <button type="button" onClick={() => classify("wall")}>设为墙面</button>
            <button className="ignore-action" type="button" onClick={() => classify("ignore")}>设为不要</button>
          </div>
        )}
        {selection?.type === "opening" && (
          <div className="candidate-actions">
            <button type="button" onClick={() => classify("door")}>设为门</button>
            <button type="button" onClick={() => classify("window")}>设为窗</button>
            <button className="ignore-action" type="button" onClick={() => classify("ignore")}>设为不要</button>
          </div>
        )}
        <div className="candidate-history">
          <button type="button" disabled={!historyRef.current.length} onClick={undo}>撤销</button>
          <button type="button" onClick={reset}>恢复识别结果</button>
        </div>
      </div>
      <div className="preview-summary">
        <span><i className="legend-wall" />墙面 {walls.filter((wall) => wall.active).length}</span>
        <span><i className="legend-door" />门 {activeOpenings.filter((item) => item.kind === "door").length}</span>
        <span><i className="legend-window" />窗 {activeOpenings.filter((item) => item.kind === "window").length}</span>
        <span><i className="legend-ignore" />灰色为不要</span>
      </div>
    </div>
  )
}
