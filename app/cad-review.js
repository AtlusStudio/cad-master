"use client"

import { useEffect, useRef, useState } from "react"
import {
  AppWindow,
  Ban,
  Check,
  DoorOpen,
  PencilLine,
  RotateCcw,
  Undo2,
  X,
} from "lucide-react"

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
    if (managerRef.current) {
      applyColors(managerRef.current, walls)
    }
  }, [walls])

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
        : selection?.type === "wall" ? "已选择墙面候选"
          : selection?.type === "opening" ? "已选择门窗候选"
            : "请在图纸中点击或框选候选"

  return (
    <div className="overflow-hidden border border-slate-200 bg-slate-50 lg:flex lg:min-h-0 lg:flex-1 lg:flex-col">
      <div className="relative h-[420px] min-h-[320px] bg-[#08111b] lg:h-auto lg:flex-1">
        <div
          ref={containerRef}
          className="size-full outline-none focus:ring-2 focus:ring-inset focus:ring-[#ff6b2c]"
          tabIndex="0"
          onKeyDown={(event) => {
            if (event.key === "Escape") cancelDrawing()
            if (event.key === "Delete" || event.key === "Backspace") event.preventDefault()
          }}
        />
        {viewerState !== "ready" && (
          <div className="absolute inset-0 grid place-items-center bg-[#08111b] font-mono text-xs text-slate-400">
            {viewerState === "loading" ? "正在载入 CAD 查看器…" : viewerState}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-3 border-t border-slate-700 bg-[#111923] p-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex items-center gap-1 overflow-x-auto whitespace-nowrap [&_button]:inline-flex [&_button]:shrink-0 [&_button]:items-center [&_button]:gap-1.5 [&_button]:border [&_button]:border-white/15 [&_button]:px-3 [&_button]:py-2 [&_button]:text-[10px] [&_button]:font-semibold [&_button]:text-slate-300 [&_button]:hover:bg-white/10 [&_button]:disabled:cursor-not-allowed [&_button]:disabled:opacity-30 [&_button[aria-pressed=true]]:border-[#ff6b2c] [&_button[aria-pressed=true]]:bg-[#ff6b2c] [&_button[aria-pressed=true]]:text-white [&_svg]:size-3.5">
          <button type="button" aria-pressed={drawing === "wall"} disabled={viewerState !== "ready"} onClick={() => startDrawing("wall")}><PencilLine aria-hidden="true" />画墙</button>
          <button type="button" aria-pressed={drawing === "door"} disabled={viewerState !== "ready"} onClick={() => startDrawing("door")}><DoorOpen aria-hidden="true" />画门</button>
          <button type="button" aria-pressed={drawing === "window"} disabled={viewerState !== "ready"} onClick={() => startDrawing("window")}><AppWindow aria-hidden="true" />画窗</button>
          <button type="button" disabled={!drawing} onClick={cancelDrawing}><X aria-hidden="true" />取消</button>
          <span className="mx-1 h-5 w-px shrink-0 bg-white/15" aria-hidden="true" />
          <button type="button" disabled={selection?.type !== "wall"} onClick={() => classify("wall")}><Check aria-hidden="true" />设为墙面</button>
          <button type="button" disabled={selection?.type !== "opening"} onClick={() => classify("door")}><DoorOpen aria-hidden="true" />设为门</button>
          <button type="button" disabled={selection?.type !== "opening"} onClick={() => classify("window")}><AppWindow aria-hidden="true" />设为窗</button>
          <button className="enabled:!text-red-300" type="button" disabled={!selection} onClick={() => classify("ignore")}><Ban aria-hidden="true" />设为不要</button>
          <span className="mx-1 h-5 w-px shrink-0 bg-white/15" aria-hidden="true" />
          <button type="button" disabled={!historyRef.current.length} onClick={undo}><Undo2 aria-hidden="true" />撤销</button>
          <button type="button" onClick={reset}><RotateCcw aria-hidden="true" />恢复识别结果</button>
        </div>
        <span className="font-mono text-[9px] text-slate-500">{drawingLabel}</span>
      </div>
      <p className="border-b border-slate-200 bg-slate-100 px-4 py-2 font-mono text-[9px] text-slate-400">滚轮缩放 · 中键拖动平移 · 单击或框选候选 · Esc 取消绘制</p>
      <div className="flex flex-wrap gap-x-5 gap-y-2 border-t border-slate-200 bg-slate-50 px-4 py-3 text-[10px] text-slate-500 [&_span]:flex [&_span]:items-center [&_span]:gap-2 [&_i]:size-2 [&_i]:rounded-full">
        <span><i className="bg-emerald-400" />墙面 {walls.filter((wall) => wall.active).length}</span>
        <span><i className="bg-yellow-400" />门 {activeOpenings.filter((item) => item.kind === "door").length}</span>
        <span><i className="bg-pink-400" />窗 {activeOpenings.filter((item) => item.kind === "window").length}</span>
        <span><i className="bg-slate-400" />灰色为不要</span>
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
