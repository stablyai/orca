import { useCallback, useEffect, useRef, useState } from 'react'
import { renderMarkupScene } from './markup-canvas-render'
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
  type MarkupTool
} from './markup-drawing-model'

type Size = { width: number; height: number }

// Owns the markup surface: document, active tool/style, the pending text box, and
// the canvas paint effect. Draw-only — committed shapes are not re-editable.
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

  // Repaint committed + in-progress shapes on any change.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }
    renderMarkupScene(canvas, {
      shapes: doc.shapes,
      inProgress,
      cssWidth: size.width,
      cssHeight: size.height
    })
  }, [doc, inProgress, size])

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
  const clear = useCallback(() => {
    // Why: also drop any open text input / in-progress stroke so a clear leaves a
    // truly clean slate — otherwise a pending input blur can re-add text.
    setPendingText(null)
    setInProgress(null)
    setDoc((current) => clearShapes(current))
  }, [])

  useMarkupKeyboardShortcuts({ pendingText, setPendingText, undo, redo, onCancel })

  const pointerHandlers = useMarkupPointerHandlers({
    busy,
    tool,
    color,
    width,
    pendingText,
    canvasRef,
    setInProgress,
    setPendingText,
    setDoc
  })

  const commitPendingText = useCallback(
    (text: string) => {
      const at = pendingText
      setPendingText(null)
      const trimmed = text.trim()
      if (!at || trimmed.length === 0) {
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
    [color, fontSize, pendingText]
  )

  const cancelPendingText = useCallback(() => setPendingText(null), [])

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
    setTool,
    setColor,
    setWidth,
    setFontSize,
    undo,
    redo,
    clear,
    ...pointerHandlers,
    commitPendingText,
    cancelPendingText
  }
}
