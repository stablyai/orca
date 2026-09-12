import React, { useCallback, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { MarkupToolbar } from './MarkupToolbar'
import type { MarkupBaseImage } from './markup-base-image'
import type { MarkupShape } from './markup-drawing-model'
import { TEXT_FONT_FAMILY } from './markup-shape-render'
import { useMarkupEditor } from './useMarkupEditor'

export type MarkupOverlayProps = {
  baseImage: MarkupBaseImage
  busy: boolean
  onComplete: (input: { imageElement: HTMLImageElement; shapes: MarkupShape[] }) => void
  onCancel: () => void
}

export function MarkupOverlay({
  baseImage,
  busy,
  onComplete,
  onCancel
}: MarkupOverlayProps): React.JSX.Element {
  const baseImgRef = useRef<HTMLImageElement | null>(null)
  const [baseLoaded, setBaseLoaded] = useState(false)
  const editor = useMarkupEditor(busy, onCancel)
  const { pendingText } = editor

  const handleDone = useCallback(() => {
    const imageElement = baseImgRef.current
    if (!imageElement || !baseLoaded) {
      return
    }
    onComplete({ imageElement, shapes: editor.shapes })
  }, [baseLoaded, editor.shapes, onComplete])

  return (
    <div
      ref={editor.rootRef}
      data-orca-markup-overlay
      className="absolute inset-0 z-20 overflow-hidden"
    >
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
        ref={editor.canvasRef}
        className={cn(
          'absolute inset-0 h-full w-full touch-none',
          busy ? 'cursor-progress' : 'cursor-crosshair'
        )}
        onPointerDown={editor.onPointerDown}
        onPointerMove={editor.onPointerMove}
        onPointerUp={editor.onPointerUp}
        onPointerCancel={editor.onPointerUp}
      />

      {pendingText ? (
        <input
          ref={editor.textInputRef}
          // Why: key by position so each placement re-mounts a fresh input.
          key={`${pendingText.x},${pendingText.y}`}
          defaultValue={pendingText.initial}
          aria-label={translate('auto.components.browser-pane.markup.textInput', 'Annotation text')}
          onPointerDown={(event) => event.stopPropagation()}
          onBlur={(event) => editor.commitPendingText(event.target.value)}
          onKeyDown={(event) => {
            // Why: keep keystrokes local — without this the browser pane's global
            // key handlers can swallow typing before it reaches the input.
            event.stopPropagation()
            // Why: during IME composition (e.g. Japanese conversion), Enter
            // confirms the candidate — it must NOT also commit the annotation.
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              editor.commitPendingText(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              editor.cancelPendingText()
            }
          }}
          // Why: the input renders ONLY the editable glyphs (no box of its own) —
          // the selection frame is drawn on the canvas so it's identical whether
          // selecting or editing. No padding/border + the same font as the canvas
          // so the text sits exactly where it commits. field-sizing hugs the text
          // so clicks outside it still reach the canvas.
          className="absolute z-30 min-w-0 border-0 bg-transparent p-0 leading-none outline-none [field-sizing:content]"
          style={{
            left: pendingText.x,
            top: pendingText.y,
            color: editor.color,
            fontSize: editor.fontSize,
            fontWeight: 600,
            fontFamily: TEXT_FONT_FAMILY,
            // Why: force line-height to 1 (the UA default ~1.2 pushes the glyph
            // down) and zero the height so the text top aligns with the canvas's
            // textBaseline:'top' render — otherwise editing text sits slightly low.
            lineHeight: 1,
            height: '1em',
            boxSizing: 'content-box',
            padding: 0,
            textShadow:
              editor.color.toLowerCase() === '#ffffff'
                ? '0 0 3px rgba(0,0,0,0.7)'
                : '0 0 3px rgba(255,255,255,0.9), 0 0 2px rgba(255,255,255,0.9)'
          }}
        />
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex flex-col items-center gap-2 px-3">
        <div className="pointer-events-auto">
          <MarkupToolbar
            tool={editor.tool}
            onToolChange={editor.setTool}
            color={editor.color}
            onColorChange={editor.setColor}
            width={editor.width}
            onWidthChange={editor.setWidth}
            fontSize={editor.fontSize}
            onFontSizeChange={editor.setFontSize}
            canUndo={editor.canUndo}
            canRedo={editor.canRedo}
            onUndo={editor.undo}
            onRedo={editor.redo}
            onClear={editor.clear}
          />
        </div>
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
            {translate('auto.components.browser-pane.markup.copy', 'Copy Markup')}
          </Button>
        </div>
      </div>
    </div>
  )
}
