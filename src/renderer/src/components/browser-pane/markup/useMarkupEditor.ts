import { useCallback, useEffect, useRef, useState } from 'react'
import { renderMarkupScene } from './markup-canvas-render'
import { restyleShapeInDocument, setTextInDocument } from './markup-editor-document'
import { useMarkupKeyboardShortcuts, type PendingText } from './useMarkupKeyboardShortcuts'
import { useMarkupPointerHandlers } from './useMarkupPointerHandlers'
import {
  canRedo,
  canUndo,
  clearShapes,
  commitShape,
  createMarkupDocument,
  DEFAULT_MARKUP_COLOR,
  DEFAULT_MARKUP_FONT_SIZE,
  DEFAULT_MARKUP_WIDTH,
  redoShape,
  undoShape,
  type MarkupDocument,
  type MarkupShape,
  type MarkupStylePatch,
  type MarkupTool
} from './markup-drawing-model'

type Size = { width: number; height: number }

// Owns the markup surface (document, tools, selection/drag editing, canvas effects).
export function useMarkupEditor(busy: boolean, onCancel: () => void) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textInputRef = useRef<HTMLInputElement | null>(null)

  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [doc, setDoc] = useState<MarkupDocument>(() => createMarkupDocument())
  const [inProgress, setInProgress] = useState<MarkupShape | null>(null)
  const [tool, setTool] = useState<MarkupTool>('pen')
  const [color, setColor] = useState<string>(DEFAULT_MARKUP_COLOR)
  const [width, setWidth] = useState<number>(DEFAULT_MARKUP_WIDTH)
  const [fontSize, setFontSize] = useState<number>(DEFAULT_MARKUP_FONT_SIZE)
  const [pendingText, setPendingText] = useState<PendingText | null>(null)
  const [editingTextId, setEditingTextId] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [dragOffset, setDragOffset] = useState<{ dx: number; dy: number } | null>(null)

  // Why: refs mirror selection/drag so handlers read live values without churn.
  const selectedIdRef = useRef<string | null>(null)
  const dragRef = useRef<{ id: string; startX: number; startY: number } | null>(null)
  const dragOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 })

  const select = useCallback((id: string | null) => {
    selectedIdRef.current = id
    setSelectedId(id)
  }, [])

  // Track the content-box size so the canvas matches the frozen backdrop exactly.
  useEffect(() => {
    const root = rootRef.current
    if (!root) {
      return undefined
    }
    const measure = () => {
      const rect = root.getBoundingClientRect()
      setSize({ width: rect.width, height: rect.height })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    return () => observer.disconnect()
  }, [])

  // Repaint committed + in-progress shapes (and the selection box) on any change.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }
    renderMarkupScene(canvas, {
      shapes: doc.shapes,
      inProgress,
      dragId: dragRef.current?.id ?? null,
      dragOffset,
      selectedId,
      cssWidth: size.width,
      cssHeight: size.height
    })
  }, [doc, inProgress, size, dragOffset, selectedId])

  // Why: focus the text input on mount — a placement click can beat autoFocus.
  useEffect(() => {
    if (!pendingText) {
      return undefined
    }
    const handle = requestAnimationFrame(() => textInputRef.current?.focus())
    return () => cancelAnimationFrame(handle)
  }, [pendingText])

  const undo = useCallback(() => setDoc((current) => undoShape(current)), [])
  const redo = useCallback(() => setDoc((current) => redoShape(current)), [])
  const clear = useCallback(() => setDoc((current) => clearShapes(current)), [])

  useMarkupKeyboardShortcuts({
    pendingText,
    selectedIdRef,
    setPendingText,
    setEditingTextId,
    select,
    setDoc,
    undo,
    redo,
    onCancel
  })

  const pointerHandlers = useMarkupPointerHandlers({
    busy,
    tool,
    color,
    width,
    shapes: doc.shapes,
    pendingText,
    canvasRef,
    dragRef,
    dragOffsetRef,
    select,
    setTool,
    setInProgress,
    setPendingText,
    setEditingTextId,
    setColor,
    setFontSize,
    setDragOffset,
    setDoc
  })

  const commitPendingText = useCallback(
    (text: string) => {
      const at = pendingText
      const editId = editingTextId
      setPendingText(null)
      setEditingTextId(null)
      if (!at) {
        return
      }
      const trimmed = text.trim()
      if (editId) {
        // Why: re-edit — setTextInDocument replaces, or removes if cleared.
        setDoc((document) => setTextInDocument(document, editId, trimmed, color, fontSize))
        return
      }
      if (trimmed.length === 0) {
        return
      }
      setDoc((document) =>
        commitShape(document, {
          id: crypto.randomUUID(),
          kind: 'text',
          color,
          at,
          text: trimmed,
          fontSize
        })
      )
    },
    [color, editingTextId, fontSize, pendingText]
  )

  const cancelPendingText = useCallback(() => {
    setPendingText(null)
    setEditingTextId(null)
  }, [])

  const handleToolChange = useCallback(
    (next: MarkupTool) => {
      setTool(next)
      if (next !== 'select') {
        select(null)
      }
    },
    [select]
  )

  const applyStyleToSelected = useCallback((patch: MarkupStylePatch) => {
    const id = selectedIdRef.current
    if (!id) {
      return
    }
    setDoc((document) => restyleShapeInDocument(document, id, patch))
  }, [])

  const handleColorChange = useCallback(
    (next: string) => {
      setColor(next)
      applyStyleToSelected({ color: next })
    },
    [applyStyleToSelected]
  )
  const handleWidthChange = useCallback(
    (next: number) => {
      setWidth(next)
      applyStyleToSelected({ width: next })
    },
    [applyStyleToSelected]
  )
  const handleFontSizeChange = useCallback(
    (next: number) => {
      setFontSize(next)
      applyStyleToSelected({ fontSize: next })
    },
    [applyStyleToSelected]
  )

  return {
    rootRef,
    canvasRef,
    textInputRef,
    tool,
    color,
    width,
    fontSize,
    pendingText,
    shapes: doc.shapes,
    canUndo: canUndo(doc),
    canRedo: canRedo(doc),
    setTool: handleToolChange,
    setColor: handleColorChange,
    setWidth: handleWidthChange,
    setFontSize: handleFontSizeChange,
    undo,
    redo,
    clear,
    ...pointerHandlers,
    commitPendingText,
    cancelPendingText
  }
}
