import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { blitMarkupScene, renderCommittedLayer } from './markup-canvas-render'
import { useMarkupKeyboardShortcuts, type PendingText } from './useMarkupKeyboardShortcuts'
import { useMarkupPointerHandlers } from './useMarkupPointerHandlers'
import {
  applyDocumentCommand,
  canUndoMarkup,
  redoMarkup,
  undoMarkup,
  type MarkupEditorState
} from './markup-gesture'
import type { TextInkBoxMeasurer } from './markup-shape-hit-test'
import { textInkBox } from './markup-shape-render'
import {
  canRedo,
  clearShapes,
  commitShape,
  createMarkupDocument,
  DEFAULT_MARKUP_COLOR,
  DEFAULT_MARKUP_FONT_SIZE,
  DEFAULT_MARKUP_WIDTH,
  type MarkupTool
} from './markup-drawing-model'

type Size = { width: number; height: number; dpr: number }

// Owns the markup surface: document, active tool/style, the pending text box, and
// the canvas paint effect. Committed shapes can be erased but not re-edited.
export function useMarkupEditor(busy: boolean, onCancel: () => void) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const textInputRef = useRef<HTMLInputElement | null>(null)
  // Why: committed shapes are rasterized once into this offscreen layer; the live
  // paint blits it instead of re-stroking every committed shape each pointermove.
  const committedLayerRef = useRef<HTMLCanvasElement | null>(null)
  if (committedLayerRef.current === null) {
    committedLayerRef.current = document.createElement('canvas')
  }

  const [size, setSize] = useState<Size>({ width: 0, height: 0, dpr: 1 })
  const [{ doc, gesture }, setState] = useState<MarkupEditorState>(() => ({
    doc: createMarkupDocument(),
    gesture: null
  }))
  const drawing = gesture?.kind === 'draw' ? gesture.shape : null
  const erasedIds = gesture?.kind === 'erase' ? gesture.erasedIds : null
  // Why: one list drives both the canvas and the export, so marks hidden by an
  // in-flight erase can never end up in the copied PNG.
  const shapes = useMemo(
    () =>
      erasedIds && erasedIds.size > 0
        ? doc.shapes.filter((shape) => !erasedIds.has(shape.id))
        : doc.shapes,
    [doc.shapes, erasedIds]
  )
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
      const dpr = window.devicePixelRatio || 1
      // Why: bail on an unchanged measurement so an identical ResizeObserver/resize
      // tick can't schedule a redundant repaint.
      setSize((prev) =>
        prev.width === rect.width && prev.height === rect.height && prev.dpr === dpr
          ? prev
          : { width: rect.width, height: rect.height, dpr }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(root)
    // Why: a monitor move changes devicePixelRatio without changing the element's
    // CSS box, so ResizeObserver won't fire — window resize (which Chromium emits
    // on dpr changes) re-measures the dpr so the canvas repaints at the new scale.
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  // Rasterize committed shapes into the offscreen layer only when they (or the
  // size) change — not on every in-progress pointermove.
  useEffect(() => {
    const layer = committedLayerRef.current
    if (!layer) {
      return
    }
    renderCommittedLayer(layer, shapes, size.width, size.height, size.dpr)
  }, [shapes, size])

  // Blit the cached layer + the in-progress shape, coalesced to one paint per
  // frame so a burst of pointermove events can't queue redundant full repaints.
  useEffect(() => {
    const canvas = canvasRef.current
    const layer = committedLayerRef.current
    if (!canvas || !layer) {
      return undefined
    }
    const handle = requestAnimationFrame(() => {
      blitMarkupScene(canvas, layer, drawing, size.width, size.height, size.dpr)
    })
    return () => cancelAnimationFrame(handle)
  }, [shapes, drawing, size])

  // Why: focus the text input on mount — a placement click can beat autoFocus.
  useEffect(() => {
    if (!pendingText) {
      return undefined
    }
    const handle = requestAnimationFrame(() => textInputRef.current?.focus())
    return () => cancelAnimationFrame(handle)
  }, [pendingText])

  const undo = useCallback(() => setState(undoMarkup), [])
  const redo = useCallback(() => setState(redoMarkup), [])
  const clear = useCallback(() => {
    // Why: also drop any open text input so a clear leaves a truly clean slate —
    // otherwise a pending input blur can re-add text.
    setPendingText(null)
    setState((state) => applyDocumentCommand(state, clearShapes))
  }, [])

  const measureTextInkBox = useCallback<TextInkBoxMeasurer>((shape) => {
    const ctx = committedLayerRef.current?.getContext('2d')
    return ctx ? textInkBox(ctx, shape) : null
  }, [])

  useMarkupKeyboardShortcuts({ pendingText, setPendingText, undo, redo, onCancel })

  const pointerHandlers = useMarkupPointerHandlers({
    busy,
    tool,
    color,
    width,
    pendingText,
    canvasRef,
    measureTextInkBox,
    setPendingText,
    setState
  })

  const commitPendingText = useCallback(
    (text: string) => {
      const at = pendingText
      setPendingText(null)
      const trimmed = text.trim()
      if (!at || trimmed.length === 0) {
        return
      }
      setState((state) => ({
        ...state,
        doc: commitShape(state.doc, {
          id: createBrowserUuid(),
          kind: 'text',
          color,
          at,
          text: trimmed,
          fontSize
        })
      }))
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
    shapes,
    canUndo: canUndoMarkup({ doc, gesture }),
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
