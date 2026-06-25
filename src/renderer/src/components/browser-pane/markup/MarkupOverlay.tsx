import React, { useCallback, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { MarkupToolbar } from './MarkupToolbar'
import type { MarkupBaseImage } from './markup-base-image'
import type { MarkupShape } from './markup-drawing-model'
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
          busy
            ? 'cursor-progress'
            : editor.tool === 'select'
              ? 'cursor-default'
              : 'cursor-crosshair'
        )}
        onPointerDown={editor.onPointerDown}
        onPointerMove={editor.onPointerMove}
        onPointerUp={editor.onPointerUp}
        onPointerCancel={editor.onPointerUp}
        onDoubleClick={editor.onDoubleClick}
      />

      {pendingText ? (
        <input
          ref={editor.textInputRef}
          // Why: re-mount per placement (keyed by position) so defaultValue
          // re-applies when re-editing an existing text shape.
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
          // Why: transparent background + ink-colored text with a halo so the
          // typing preview matches the committed look and doesn't show a dark
          // theme box over the screenshot.
          className="absolute z-30 rounded-sm border border-dashed border-ring bg-transparent px-1 py-0.5 leading-tight outline-none"
          style={{
            left: pendingText.x,
            top: pendingText.y,
            color: editor.color,
            fontSize: editor.fontSize,
            textShadow:
              editor.color.toLowerCase() === '#ffffff'
                ? '0 0 3px rgba(0,0,0,0.7)'
                : '0 0 3px rgba(255,255,255,0.9), 0 0 2px rgba(255,255,255,0.9)'
          }}
        />
      ) : null}

      <div className="pointer-events-none absolute inset-x-0 top-2 flex justify-center">
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
