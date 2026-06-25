import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { MarkupToolbar } from './MarkupToolbar'
import type { MarkupBaseImage } from './markup-base-image'
import { clampMarkupScale } from './markup-screenshot-compose'
import { drawShapes } from './markup-shape-render'
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
  type MarkupPoint,
  type MarkupShape,
  type MarkupToolKind
} from './markup-drawing-model'

export type MarkupOverlayProps = {
  baseImage: MarkupBaseImage
  busy: boolean
  onComplete: (input: { imageElement: HTMLImageElement; shapes: MarkupShape[] }) => void
  onCancel: () => void
}

type Size = { width: number; height: number }
type PendingText = { x: number; y: number }

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

export function MarkupOverlay({
  baseImage,
  busy,
  onComplete,
  onCancel
}: MarkupOverlayProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const baseImgRef = useRef<HTMLImageElement | null>(null)
  const textInputRef = useRef<HTMLInputElement | null>(null)

  const [size, setSize] = useState<Size>({ width: 0, height: 0 })
  const [doc, setDoc] = useState<MarkupDocument>(() => createMarkupDocument())
  const [inProgress, setInProgress] = useState<MarkupShape | null>(null)
  const [tool, setTool] = useState<MarkupToolKind>('pen')
  const [color, setColor] = useState<string>(DEFAULT_MARKUP_COLOR)
  const [width, setWidth] = useState<number>(DEFAULT_MARKUP_WIDTH)
  const [pendingText, setPendingText] = useState<PendingText | null>(null)
  const [baseLoaded, setBaseLoaded] = useState(false)

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

  // Repaint committed + in-progress shapes whenever they (or the size) change.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }
    // Why: clamp identically to the compositor (markup-screenshot-compose) so
    // the live preview and the exported PNG render shapes at the same scale.
    const dpr = clampMarkupScale(window.devicePixelRatio || 1)
    const pixelWidth = Math.max(1, Math.round(size.width * dpr))
    const pixelHeight = Math.max(1, Math.round(size.height * dpr))
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth
      canvas.height = pixelHeight
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)
    drawShapes(ctx, doc.shapes)
    if (inProgress) {
      drawShapes(ctx, [inProgress])
    }
  }, [doc, inProgress, size])

  // Why: focus the text input the moment it appears — a real placement click can
  // beat autoFocus, leaving the field unfocused so keystrokes go nowhere.
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

  // Keyboard: undo/redo + Esc, platform-correct and ignored while typing.
  useEffect(() => {
    const isMac = navigator.userAgent.includes('Mac')
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (pendingText) {
          setPendingText(null)
        } else {
          onCancel()
        }
        return
      }
      if (isTypingTarget(event.target)) {
        return
      }
      const mod = isMac ? event.metaKey : event.ctrlKey
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault()
        if (event.shiftKey) {
          redo()
        } else {
          undo()
        }
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel, pendingText, redo, undo])

  const pointFromEvent = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>): MarkupPoint => {
      const canvas = canvasRef.current
      if (!canvas) {
        return { x: 0, y: 0 }
      }
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    },
    []
  )

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      if (busy || event.button !== 0) {
        return
      }
      const point = pointFromEvent(event)
      if (tool === 'text') {
        // Why: stop the canvas mousedown from stealing focus so the text input
        // that mounts next keeps it.
        event.preventDefault()
        setPendingText(point)
        return
      }
      event.currentTarget.setPointerCapture(event.pointerId)
      const id = crypto.randomUUID()
      if (tool === 'pen' || tool === 'highlight') {
        setInProgress({ id, kind: tool, color, width, points: [point] })
      } else {
        setInProgress({ id, kind: tool, color, width, from: point, to: point })
      }
    },
    [busy, color, pointFromEvent, tool, width]
  )

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      setInProgress((current) => {
        if (!current) {
          return current
        }
        const point = pointFromEvent(event)
        if (current.kind === 'pen' || current.kind === 'highlight') {
          return { ...current, points: [...current.points, point] }
        }
        if (current.kind === 'text') {
          return current
        }
        return { ...current, to: point }
      })
    },
    [pointFromEvent]
  )

  const handlePointerUp = useCallback(() => {
    setInProgress((current) => {
      if (current) {
        setDoc((document) => commitShape(document, current))
      }
      return null
    })
  }, [])

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
          fontSize: DEFAULT_MARKUP_FONT_SIZE
        })
      )
    },
    [color, pendingText]
  )

  const handleDone = useCallback(() => {
    const imageElement = baseImgRef.current
    if (!imageElement || !baseLoaded) {
      return
    }
    onComplete({ imageElement, shapes: doc.shapes })
  }, [baseLoaded, doc.shapes, onComplete])

  return (
    <div ref={rootRef} data-orca-markup-overlay className="absolute inset-0 z-20 overflow-hidden">
      <img
        ref={baseImgRef}
        src={baseImage.dataUrl}
        alt=""
        draggable={false}
        onLoad={() => setBaseLoaded(true)}
        onError={() => {
          // Why: the backdrop is a self-generated data URL, so a decode failure is
          // unexpected — but never trap the user with a permanently-disabled Done.
          console.error('markup: base screenshot failed to load')
          onCancel()
        }}
        className="pointer-events-none absolute inset-0 block h-full w-full select-none"
        style={{ objectFit: 'fill' }}
      />
      <canvas
        ref={canvasRef}
        className={cn(
          'absolute inset-0 h-full w-full touch-none',
          busy ? 'cursor-progress' : 'cursor-crosshair'
        )}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />

      {pendingText ? (
        <input
          ref={textInputRef}
          defaultValue=""
          aria-label={translate('auto.components.browser-pane.markup.textInput', 'Annotation text')}
          onPointerDown={(event) => event.stopPropagation()}
          onBlur={(event) => commitPendingText(event.target.value)}
          onKeyDown={(event) => {
            // Why: keep keystrokes local — without this the browser pane's global
            // key handlers can swallow typing before it reaches the input.
            event.stopPropagation()
            if (event.key === 'Enter') {
              event.preventDefault()
              commitPendingText(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              setPendingText(null)
            }
          }}
          className="absolute z-30 rounded-sm border border-ring bg-background/90 px-1 py-0.5 text-sm outline-none"
          style={{
            left: pendingText.x,
            top: pendingText.y,
            color,
            fontSize: DEFAULT_MARKUP_FONT_SIZE
          }}
        />
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
        <div className="pointer-events-auto">
          <MarkupToolbar
            tool={tool}
            onToolChange={setTool}
            color={color}
            onColorChange={setColor}
            width={width}
            onWidthChange={setWidth}
            canUndo={canUndo(doc)}
            canRedo={canRedo(doc)}
            onUndo={undo}
            onRedo={redo}
            onClear={clear}
          />
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3">
        <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-border bg-card/95 p-1.5 shadow-md backdrop-blur">
          <span className="px-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.browser-pane.markup.hint',
              'Draw on the page, then copy the markup to paste into your agent.'
            )}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            <X className="size-4" />
            {translate('auto.components.browser-pane.markup.cancel', 'Cancel')}
          </Button>
          <Button type="button" size="sm" onClick={handleDone} disabled={busy || !baseLoaded}>
            <Check className="size-4" />
            {translate('auto.components.browser-pane.markup.copy', 'Copy markup')}
          </Button>
        </div>
      </div>
    </div>
  )
}
