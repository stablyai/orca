import type { JSX } from 'react'
import { MessageSquarePlus } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { BrowserPageAnnotationTray } from '../browser-pane/annotate/browser-page-annotation-tray'
import { PendingBrowserAnnotationCard } from '../browser-pane/annotate/pending-browser-annotation-card'
import { pdfAnnotationTitle } from './pdf-annotation-output'
import type { PdfAnnotateMode, PdfAnnotationContext } from './use-pdf-annotate-mode'
import { usePdfAnnotationSend } from './use-pdf-annotation-send'

/** Lives inside the pdf.js scroll container so badges and the hover box scroll with the pages. */
export function PdfAnnotationPageLayer({
  mode,
  context
}: {
  mode: PdfAnnotateMode
  context: PdfAnnotationContext
}): JSX.Element {
  const { hoverRect, dragRect, markers, pending, pendingRegions, pendingAnchor } = mode
  return (
    <div className="pointer-events-none absolute top-0 left-0 z-10" data-pdf-annotation-overlay>
      {hoverRect ? (
        <div
          className="absolute rounded-sm border-2 border-annotation-highlight bg-annotation-highlight/15"
          style={{
            left: hoverRect.x - 2,
            top: hoverRect.y - 2,
            width: hoverRect.width + 4,
            height: hoverRect.height + 4
          }}
        />
      ) : null}
      {markers.map((marker) =>
        marker.regions.map((rect, index) => (
          <div
            key={`${marker.id}-${index}`}
            data-pdf-annotation-region
            className="absolute rounded-sm border border-annotation-highlight/70 bg-annotation-highlight/10"
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
          />
        ))
      )}
      {[...pendingRegions, ...(dragRect ? [dragRect] : [])].map((rect, index) => (
        <div
          key={`pending-${index}`}
          className="absolute rounded-sm border-2 border-annotation-highlight bg-annotation-highlight/15"
          style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
        />
      ))}
      {markers.map((marker) => (
        <div
          key={marker.id}
          data-pdf-annotation-badge
          className="absolute flex size-6 items-center justify-center rounded-full border border-background bg-primary text-[11px] font-semibold text-primary-foreground shadow-xs select-none"
          style={
            marker.regions.length > 0
              ? { left: marker.x - 12, top: marker.y - 12 }
              : { left: marker.x - 12, top: marker.y - 30 }
          }
        >
          {marker.index + 1}
        </div>
      ))}
      {pending && pendingAnchor ? (
        <PendingBrowserAnnotationCard
          title={pdfAnnotationTitle(pending)}
          subtitle={context.displayPath}
          ariaLabel={translate(
            'auto.components.editor.PdfViewer.addPdfAnnotation',
            'Add PDF annotation'
          )}
          beside
          hint={translate(
            'auto.components.editor.PdfViewer.pdfAnnotateAddRegionHint',
            'Shift+click a paragraph or Shift+drag to add another area to this comment.'
          )}
          onPointerDownOutside={(event) => {
            if (event.detail.originalEvent.shiftKey) {
              event.preventDefault()
            }
          }}
          anchor={{ ...pendingAnchor, below: false }}
          portalContainer={mode.surface}
          onAdd={mode.add}
          onCancel={mode.cancel}
        />
      ) : null}
    </div>
  )
}

export function PdfAnnotationTray({
  mode,
  context
}: {
  mode: PdfAnnotateMode
  context: PdfAnnotationContext
}): JSX.Element | null {
  const send = usePdfAnnotationSend(context, mode.annotations)
  if (mode.annotations.length === 0) {
    return null
  }
  return <BrowserPageAnnotationTray {...send} getAnnotationTitle={pdfAnnotationTitle} />
}

export function PdfAnnotateButton({ mode }: { mode: PdfAnnotateMode }): JSX.Element {
  const label = translate('auto.components.editor.PdfViewer.annotatePdf', 'Annotate PDF')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'relative rounded p-1 hover:bg-accent hover:text-foreground',
            mode.active && 'bg-foreground/80 text-background hover:bg-foreground/90'
          )}
          onClick={mode.toggle}
          aria-pressed={mode.active}
          aria-label={label}
        >
          <MessageSquarePlus size={14} />
          {mode.annotations.length > 0 ? (
            <span className="absolute -top-1.5 -right-1.5 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
              {mode.annotations.length}
            </span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
