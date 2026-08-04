"use client"

import { useEffect, useRef, useState } from "react"

import { matchOpeningToWall, rectangleToWall } from "./cad-review-geometry"

const REVIEW_LAYERS = {
  wall: "CADMASTER_REVIEW_WALL",
  door: "CADMASTER_REVIEW_DOOR",
  window: "CADMASTER_REVIEW_WINDOW",
  ignore: "CADMASTER_REVIEW_IGNORE",
}

const RECT_SETTINGS = {
  chamferDist1: 0,
  chamferDist2: 0,
  filletRadius: 0,
  width: 0,
  elevation: 0,
  thickness: 0,
  rotation: 0,
}

async function promptPoint(cad, manager, message, basePoint, jig) {
  const options = new cad.AcEdPromptPointOptions(message)
  if (basePoint) {
    options.basePoint = basePoint
    options.useBasePoint = true
    options.useDashedLine = true
  }
  if (jig) options.jig = jig
  const result = await manager.editor.getPoint(options)
  return result.status === cad.AcEdPromptStatus.OK ? result.value : null
}

export default function CadReview({ walls, entityMap, reviewUrl, onChange }) {
  const containerRef = useRef(null)
  const managerRef = useRef(null)
  const cadRef = useRef(null)
  const wallsRef = useRef(walls)
  const originalWallsRef = useRef(walls)
  const entityMapRef = useRef(entityMap)
  const manualEntityMapRef = useRef({})
  const manualEntitiesRef = useRef(new Map())
  const historyRef = useRef([])
  const drawTokenRef = useRef(0)
  const wallNumberRef = useRef(nextManualNumber(walls, "MW"))
  const openingNumberRef = useRef(nextManualNumber(walls, "MO"))
  const [selection, setSelection] = useState(null)
  const [drawing, setDrawing] = useState(null)
  const [viewerState, setViewerState] = useState("loading")

  function mappedEntities() {
    return { ...entityMapRef.current, ...manualEntityMapRef.current }
  }

  function handlesFor(item) {
    return Object.entries(mappedEntities())
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
      for (const [handle, item] of Object.entries(mappedEntities())) {
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

  function removeMissingManualEntities(nextWalls) {
    const alive = new Set(nextWalls.flatMap((wall) => [
      ...(wall.manual ? [wall.id] : []),
      ...wall.openings.filter((opening) => opening.manual).map((opening) => opening.id),
    ]))
    const removedIds = new Set()
    const objectIds = []
    for (const [id, objectId] of manualEntitiesRef.current) {
      if (alive.has(id)) continue
      removedIds.add(id)
      objectIds.push(objectId)
      delete manualEntityMapRef.current[objectId]
      manualEntitiesRef.current.delete(id)
    }
    if (objectIds.length) managerRef.current?.curDocument.entityService.eraseEntities(objectIds)
    if (removedIds.size) {
      setSelection((current) => current && removedIds.has(current.id) ? null : current)
    }
  }

  function commitWalls(nextWalls) {
    wallsRef.current = nextWalls
    removeMissingManualEntities(nextWalls)
    onChange(nextWalls)
  }

  function rememberManualEntity(entity, item) {
    manualEntitiesRef.current.set(item.id, entity.objectId)
    manualEntityMapRef.current[entity.objectId] = item
  }

  function appendManualEntity(entity, item, layer) {
    entity.layer = layer
    managerRef.current.curDocument.entityService.runEdit("手工绘制", () => {
      managerRef.current.curDocument.database.tables.blockTable.modelSpace.appendEntity(entity)
    })
    rememberManualEntity(entity, item)
  }

  function restoreManualEntities(cad, manager) {
    manualEntitiesRef.current.clear()
    manualEntityMapRef.current = {}
    for (const wall of wallsRef.current.filter((item) => item.manual)) {
      const [first, second] = wallRectanglePoints(wall)
      const jig = new cad.AcApRectJig(manager.curView, first, () => RECT_SETTINGS)
      jig.update(second)
      jig.entity.elevation = 1
      appendManualEntity(
        jig.entity,
        { type: "wall", id: wall.id, wallId: wall.id },
        wall.active ? REVIEW_LAYERS.wall : REVIEW_LAYERS.ignore,
      )
    }
    for (const wall of wallsRef.current) {
      for (const opening of wall.openings.filter((item) => item.manual)) {
        const start = pointAtOffset(wall, opening.startOffset)
        const end = pointAtOffset(wall, opening.endOffset)
        const jig = new cad.AcApLineJig(manager.curView, { x: start[0], y: start[1], z: 1 })
        jig.update({ x: end[0], y: end[1], z: 1 })
        appendManualEntity(
          jig.entity,
          { type: "opening", id: opening.id, wallId: wall.id },
          wall.active && opening.active ? REVIEW_LAYERS[opening.kind] : REVIEW_LAYERS.ignore,
        )
      }
    }
  }

  function nextManualId(prefix, numberRef) {
    const id = `${prefix}${String(numberRef.current).padStart(4, "0")}`
    numberRef.current += 1
    return id
  }

  function cancelDrawing() {
    drawTokenRef.current += 1
    managerRef.current?.editor.cancelActiveInput()
    if (managerRef.current && cadRef.current) {
      managerRef.current.curView.mode = cadRef.current.AcEdViewMode.SELECTION
    }
    setDrawing(null)
  }

  async function startDrawing(kind) {
    const manager = managerRef.current
    const cad = cadRef.current
    if (!manager || !cad || viewerState !== "ready") return

    manager.editor.cancelActiveInput()
    const token = drawTokenRef.current + 1
    drawTokenRef.current = token
    setDrawing(kind)

    try {
      const first = await promptPoint(
        cad,
        manager,
        kind === "wall" ? "指定墙体矩形的第一个角点" : "指定洞口第一个端点",
      )
      if (!first || token !== drawTokenRef.current) return

      const jig = kind === "wall"
        ? new cad.AcApRectJig(manager.curView, first, () => RECT_SETTINGS)
        : new cad.AcApLineJig(manager.curView, first)
      const second = await promptPoint(
        cad,
        manager,
        kind === "wall" ? "指定墙体矩形的另一个角点" : "指定洞口另一个端点",
        first,
        jig,
      )
      if (!second || token !== drawTokenRef.current) return

      if (kind === "wall") {
        const id = nextManualId("MW", wallNumberRef)
        const wall = rectangleToWall(first, second, id)
        if (!wall) {
          manager.editor.showMessage("墙体长度和厚度必须大于 0", "warning")
          return
        }
        jig.update(second)
        jig.entity.elevation = 1
        const item = { type: "wall", id, wallId: id }
        historyRef.current.push(wallsRef.current)
        appendManualEntity(jig.entity, item, REVIEW_LAYERS.wall)
        commitWalls([...wallsRef.current, { ...wall, active: true, manual: true, openings: [] }])
        selectItem(item)
        return
      }

      const id = nextManualId("MO", openingNumberRef)
      const match = matchOpeningToWall(wallsRef.current, first, second, id, kind)
      if (!match) {
        manager.editor.showMessage("请在墙体附近绘制门窗", "warning")
        return
      }
      const { wall: selectedWall, opening } = match
      const start = pointAtOffset(selectedWall, opening.startOffset)
      const end = pointAtOffset(selectedWall, opening.endOffset)
      jig.entity.startPoint = { x: start[0], y: start[1], z: 1 }
      jig.entity.endPoint = { x: end[0], y: end[1], z: 1 }
      const item = { type: "opening", id, wallId: selectedWall.id }
      historyRef.current.push(wallsRef.current)
      appendManualEntity(jig.entity, item, REVIEW_LAYERS[kind])
      commitWalls(wallsRef.current.map((wall) => wall.id === selectedWall.id
        ? {
            ...wall,
            active: true,
            openings: [...wall.openings, { ...opening, active: true, manual: true }],
          }
        : wall))
      selectItem(item)
    } catch (error) {
      if (token === drawTokenRef.current) manager.editor.showMessage(error.message, "error")
    } finally {
      if (token === drawTokenRef.current) {
        setDrawing(null)
        manager.curView.mode = cad.AcEdViewMode.SELECTION
      }
    }
  }

  useEffect(() => {
    entityMapRef.current = entityMap
  }, [entityMap])

  useEffect(() => {
    let cancelled = false
    let manager
    let selectionListener

    async function openViewer() {
      try {
        const cad = await import("@mlightcad/cad-simple-viewer")
        if (cancelled) return
        cadRef.current = cad
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

        const layerService = manager.curDocument.layerService
        layerService.setLayerColor(REVIEW_LAYERS.wall, layerService.parseColorInput("RGB:0,255,0"))
        layerService.setLayerColor(REVIEW_LAYERS.door, layerService.parseColorInput("RGB:255,255,0"))
        layerService.setLayerColor(REVIEW_LAYERS.window, layerService.parseColorInput("RGB:255,79,163"))
        manager.curView.onHover = () => {}
        manager.curView.mode = cad.AcEdViewMode.SELECTION
        manager.curView.selectionBoxSize = 10
        let syncingSelection = false
        selectionListener = ({ ids }) => {
          if (syncingSelection) return
          const map = mappedEntities()
          const selected = ids.map((id) => map[id]).find(Boolean)
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
        restoreManualEntities(cad, manager)
        applyColors(manager, wallsRef.current)
        setViewerState("ready")
      } catch (error) {
        if (!cancelled) setViewerState(error.message)
      }
    }

    openViewer()
    return () => {
      cancelled = true
      drawTokenRef.current += 1
      manager?.editor.cancelActiveInput()
      if (selectionListener) {
        manager?.curView.selectionSet.events.selectionAdded.removeEventListener(selectionListener)
      }
      managerRef.current = null
      cadRef.current = null
      if (manager) void manager.destroy()
    }
  }, [reviewUrl])

  useEffect(() => {
    wallsRef.current = walls
    if (managerRef.current && viewerState === "ready") {
      applyColors(managerRef.current, walls)
    }
  }, [walls, viewerState])

  function classify(kind) {
    const currentWalls = wallsRef.current
    historyRef.current.push(currentWalls)
    commitWalls(currentWalls.map((wall) => {
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
    if (previous) commitWalls(previous)
  }

  function reset() {
    cancelDrawing()
    historyRef.current = []
    wallNumberRef.current = nextManualNumber(originalWallsRef.current, "MW")
    openingNumberRef.current = nextManualNumber(originalWallsRef.current, "MO")
    setSelection(null)
    managerRef.current?.curView.selectionSet.clear()
    commitWalls(originalWallsRef.current)
  }

  const activeOpenings = walls
    .filter((wall) => wall.active)
    .flatMap((wall) => wall.openings.filter((opening) => opening.active))
  const drawingLabel = drawing === "wall" ? "正在画墙：点击矩形两个对角点"
    : drawing === "door" ? "正在画门：点击洞口两个端点"
      : drawing === "window" ? "正在画窗：点击洞口两个端点"
        : "直接绘制门窗，系统将自动匹配墙体"

  return (
    <div className="wall-preview">
      <div className="cad-viewer-shell">
        <div
          ref={containerRef}
          className="cad-viewer"
          tabIndex="0"
          onKeyDown={(event) => {
            if (event.key === "Escape") cancelDrawing()
            if (event.key === "Delete" || event.key === "Backspace") event.preventDefault()
          }}
        />
        {viewerState !== "ready" && (
          <div className="cad-viewer-state">
            {viewerState === "loading" ? "正在载入 CAD 查看器…" : viewerState}
          </div>
        )}
      </div>
      <div className="cad-draw-toolbar">
        <div>
          <button type="button" aria-pressed={drawing === "wall"} disabled={viewerState !== "ready"} onClick={() => startDrawing("wall")}>画墙</button>
          <button type="button" aria-pressed={drawing === "door"} disabled={viewerState !== "ready"} onClick={() => startDrawing("door")}>画门</button>
          <button type="button" aria-pressed={drawing === "window"} disabled={viewerState !== "ready"} onClick={() => startDrawing("window")}>画窗</button>
          <button type="button" disabled={!drawing} onClick={cancelDrawing}>取消绘制</button>
        </div>
        <span>{drawingLabel}</span>
      </div>
      <p className="cad-viewer-help">滚轮缩放 · 中键拖动平移 · 单击或框选候选 · Esc 取消绘制</p>
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

function pointAtOffset(wall, offset) {
  const length = Math.hypot(wall.end[0] - wall.start[0], wall.end[1] - wall.start[1])
  const ratio = offset / length
  return [
    wall.start[0] + (wall.end[0] - wall.start[0]) * ratio,
    wall.start[1] + (wall.end[1] - wall.start[1]) * ratio,
  ]
}

function wallRectanglePoints(wall) {
  const half = wall.thickness / 2
  return wall.start[1] === wall.end[1]
    ? [
        { x: wall.start[0], y: wall.start[1] - half },
        { x: wall.end[0], y: wall.end[1] + half },
      ]
    : [
        { x: wall.start[0] - half, y: wall.start[1] },
        { x: wall.end[0] + half, y: wall.end[1] },
      ]
}

function nextManualNumber(walls, prefix) {
  const ids = prefix === "MW"
    ? walls.filter((wall) => wall.manual).map((wall) => wall.id)
    : walls.flatMap((wall) => wall.openings.filter((opening) => opening.manual).map((opening) => opening.id))
  return Math.max(0, ...ids.map((id) => Number(id.slice(2)))) + 1
}
