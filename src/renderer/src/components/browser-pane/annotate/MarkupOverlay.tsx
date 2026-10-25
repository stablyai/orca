import { ImeInput } from '@/lib/ime-text-field'
import React, { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  /** Element outside the page box that hosts the controls as a footer instead of over the page. */
  controlsContainer?: HTMLElement | null
}

export function MarkupOverlay({
  baseImage,
  busy,
  onComplete,
  onCancel,
  controlsContainer
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

  const controls = (
    <div
      className={cn(
        'flex flex-col items-center gap-2 px-3',
        controlsContainer
          ? 'shrink-0 bg-background py-3'
          : 'pointer-events-none absolute inset-x-0 bottom-3'
      )}
    >
      {/* Why: cap at the available width so the toolbar wraps in a narrow viewport instead of clipping. */}
      <div className="pointer-events-auto max-w-full">
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
  )

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
          // Cancel on unexpected backdrop decode failure so Done cannot stay disabled forever.
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
        onPointerCancel={editor.onPointerCancel}
        // Why: commits a gesture whose release never arrived, so one can never be left open.
        onLostPointerCapture={editor.onPointerUp}
      />

      {pendingText ? (
        <ImeInput
          ref={editor.textInputRef}
          // Why: key by position so each placement re-mounts a fresh input.
          key={`${pendingText.x},${pendingText.y}`}
          defaultValue={pendingText.initial}
          aria-label={translate('auto.components.browser-pane.markup.textInput', 'Annotation text')}
          onPointerDown={(event) => event.stopPropagation()}
          onBlur={(event) => editor.commitPendingText(event.target.value)}
          onKeyDown={(event) => {
            // Keep typing local; browser-pane global handlers otherwise swallow it.
            event.stopPropagation()
            // IME Enter confirms its candidate and must not also commit the annotation.
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              editor.commitPendingText(event.currentTarget.value)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              editor.cancelPendingText()
            }
          }}
          // Match canvas typography with no input chrome; the canvas owns the selection frame and outside clicks remain reachable.
          className="absolute z-30 min-w-0 border-0 bg-transparent p-0 leading-none outline-none [field-sizing:content]"
          style={{
            left: pendingText.x,
            top: pendingText.y,
            color: editor.color,
            fontSize: editor.fontSize,
            fontWeight: 600,
            fontFamily: TEXT_FONT_FAMILY,
            // Match canvas textBaseline:top; the UA line height would shift editable glyphs down.
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

      {controlsContainer ? createPortal(controls, controlsContainer) : controls}
    </div>
  )
}
