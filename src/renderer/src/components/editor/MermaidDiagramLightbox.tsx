import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Maximize, Maximize2, X, ZoomIn, ZoomOut } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import {
  DIAGRAM_BUTTON_ZOOM_STEP,
  MIN_DIAGRAM_SCALE,
  diagramKeyAction,
  diagramMinScale,
  fitDiagramTransform,
  isSameDiagramTransform,
  wheelZoomFactor,
  zoomDiagramAt,
  type DiagramSize,
  type DiagramTransform
} from './mermaid-diagram-viewport'

type MermaidDiagramLightboxProps = {
  /** Reads the rendered diagram's sanitized SVG markup; called only when the viewer opens. */
  getSvgMarkup: () => string | null
}

type MermaidDiagramViewportProps = {
  svgMarkup: string
}

type DragState = {
  pointerId: number
  startX: number
  startY: number
  originX: number
  originY: number
}

/**
 * Corner button on a rendered mermaid diagram that opens it full-window with
 * wheel zoom and drag pan. The dialog primitive owns Escape and focus restore.
 */
export default function MermaidDiagramLightbox({
  getSvgMarkup
}: MermaidDiagramLightboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  // Why: captured on open and dropped after close so idle diagrams hold no second SVG copy.
  const [svgMarkup, setSvgMarkup] = useState<string | null>(null)
  const expandLabel = translate(
    'auto.components.editor.MermaidDiagramLightbox.expand',
    'Expand diagram'
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          const markup = getSvgMarkup()
          if (!markup) {
            return
          }
          setSvgMarkup(markup)
        }
        setOpen(nextOpen)
      }}
    >
      {/* Why: the wrapper owns hover reveal so the Button keeps its own variant styling. */}
      <div className="absolute top-2 right-2 opacity-0 transition-opacity group-hover/mermaid:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <DialogTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="icon-sm"
                contentEditable={false}
                aria-label={expandLabel}
                onClick={(event) => {
                  // Why: keep parent row/card handlers from treating this as selection.
                  event.stopPropagation()
                }}
              >
                <Maximize2 />
              </Button>
            </DialogTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {expandLabel}
          </TooltipContent>
        </Tooltip>
      </div>
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={false}
        variant="fullscreen"
        onOpenAutoFocus={(event) => {
          // Why: default focus lands on the first toolbar button and opens its tooltip,
          // so the first Escape only dismisses the tooltip. Focus the diagram viewport
          // instead, which also makes arrow-key pan and +/- zoom work right away.
          event.preventDefault()
          if (!(event.currentTarget instanceof HTMLElement)) {
            return
          }
          const viewport = event.currentTarget.querySelector('[data-mermaid-diagram-viewport]')
          if (viewport instanceof HTMLElement) {
            viewport.focus()
          } else {
            event.currentTarget.focus()
          }
        }}
        // Runs after the exit animation, so the diagram stays visible while fading out.
        onCloseAutoFocus={() => setSvgMarkup(null)}
        // Why: React bubbles portal events through the component tree, so pans and
        // clicks here would otherwise reach the markdown host's click handlers.
        onClick={(event) => event.stopPropagation()}
      >
        {svgMarkup && <MermaidDiagramViewport svgMarkup={svgMarkup} />}
      </DialogContent>
    </Dialog>
  )
}

function readSvgNaturalSize(svg: SVGSVGElement): DiagramSize {
  const viewBox = svg.viewBox.baseVal
  if (viewBox && viewBox.width > 0 && viewBox.height > 0) {
    return { width: viewBox.width, height: viewBox.height }
  }
  const rect = svg.getBoundingClientRect()
  return { width: rect.width, height: rect.height }
}

function MermaidDiagramViewport({ svgMarkup }: MermaidDiagramViewportProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const diagramRef = useRef<HTMLDivElement>(null)
  const naturalSizeRef = useRef<DiagramSize>({ width: 0, height: 0 })
  const minScaleRef = useRef(MIN_DIAGRAM_SCALE)
  // Why: auto-refit on resize only while the view is still the fitted one, so a
  // window resize never throws away the zoom/pan the user chose.
  const userAdjustedRef = useRef(false)
  // Why: mirrors `transform` so rapid wheel events chain off the latest value and
  // handlers can tell whether an input actually moved the view.
  const transformRef = useRef<DiagramTransform | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [transform, setTransform] = useState<DiagramTransform | null>(null)
  const [dragging, setDragging] = useState(false)

  const fitToViewport = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    const fitted = fitDiagramTransform(naturalSizeRef.current, {
      width: viewport.clientWidth,
      height: viewport.clientHeight
    })
    minScaleRef.current = diagramMinScale(fitted.scale)
    userAdjustedRef.current = false
    transformRef.current = fitted
    setTransform(fitted)
  }, [])

  // Why: no-op inputs (horizontal wheel, zoom at a limit, click without movement)
  // must not count as a user adjustment, or resize would stop refitting.
  const applyUserTransform = useCallback(
    (update: (current: DiagramTransform) => DiagramTransform) => {
      const current = transformRef.current
      if (!current) {
        return
      }
      const next = update(current)
      if (isSameDiagramTransform(current, next)) {
        return
      }
      userAdjustedRef.current = true
      transformRef.current = next
      setTransform(next)
    },
    []
  )

  useLayoutEffect(() => {
    const host = diagramRef.current
    if (!host) {
      return
    }
    // Why: markup is serialized from MermaidBlock's DOMPurify-sanitized inline diagram and
    // re-parsed in the same context (div innerHTML), so it needs no second pass.
    host.innerHTML = svgMarkup
    const svg = host.querySelector('svg')
    if (svg) {
      const size = readSvgNaturalSize(svg)
      naturalSizeRef.current = size
      // Why: mermaid emits width="100%" plus an inline max-width, which would tie
      // the diagram to the container; pin it to its intrinsic size and scale via transform.
      svg.setAttribute('width', String(size.width))
      svg.setAttribute('height', String(size.height))
      svg.style.maxWidth = 'none'
    }
    fitToViewport()
  }, [svgMarkup, fitToViewport])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    const observer = new ResizeObserver(() => {
      if (!userAdjustedRef.current) {
        fitToViewport()
      }
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [fitToViewport])

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    // Why: React's onWheel is passive, so it cannot stop page/app zoom or scrolling.
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const rect = viewport.getBoundingClientRect()
      const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
      const factor = wheelZoomFactor(event.deltaY, event.deltaMode)
      applyUserTransform((current) =>
        zoomDiagramAt(current, current.scale * factor, anchor, minScaleRef.current)
      )
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [applyUserTransform])

  const zoomAroundCenter = (factor: number): void => {
    const viewport = viewportRef.current
    if (!viewport) {
      return
    }
    const anchor = { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 }
    applyUserTransform((current) =>
      zoomDiagramAt(current, current.scale * factor, anchor, minScaleRef.current)
    )
  }

  const onViewportKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    // Why: leave modified keys (e.g. Ctrl+= app zoom) to the app.
    if (event.ctrlKey || event.metaKey || event.altKey) {
      return
    }
    const action = diagramKeyAction(event.key, event.shiftKey)
    if (!action) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    if (action.kind === 'fit') {
      fitToViewport()
    } else if (action.kind === 'zoom') {
      zoomAroundCenter(action.factor)
    } else {
      applyUserTransform((current) => ({
        ...current,
        x: current.x + action.dx,
        y: current.y + action.dy
      }))
    }
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) {
      return
    }
    dragRef.current = null
    setDragging(false)
  }

  const zoomPercent = Math.round((transform?.scale ?? 1) * 100)
  const title = translate('auto.components.editor.MermaidDiagramLightbox.title', 'Diagram')

  return (
    <>
      <DialogTitle className="sr-only">{title}</DialogTitle>
      <div className="relative min-h-0 flex-1">
        <div
          ref={viewportRef}
          data-mermaid-diagram-viewport=""
          data-dragging={dragging}
          role="application"
          tabIndex={0}
          aria-label={translate(
            'auto.components.editor.MermaidDiagramLightbox.viewportLabel',
            'Diagram. Arrow keys pan, plus and minus zoom, 0 fits to screen.'
          )}
          className="absolute inset-0 cursor-grab touch-none overflow-hidden bg-background outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[dragging=true]:cursor-grabbing"
          onKeyDown={onViewportKeyDown}
          onPointerDown={(event) => {
            const current = transformRef.current
            if (event.button !== 0 || !current) {
              return
            }
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = {
              pointerId: event.pointerId,
              startX: event.clientX,
              startY: event.clientY,
              originX: current.x,
              originY: current.y
            }
            setDragging(true)
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            if (!drag || drag.pointerId !== event.pointerId) {
              return
            }
            applyUserTransform((current) => ({
              ...current,
              x: drag.originX + event.clientX - drag.startX,
              y: drag.originY + event.clientY - drag.startY
            }))
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onLostPointerCapture={endDrag}
        >
          <div
            ref={diagramRef}
            className="pointer-events-none absolute top-0 left-0 origin-top-left"
            style={{
              // Why: stay hidden until the first fit so the diagram never flashes at 1:1.
              visibility: transform ? 'visible' : 'hidden',
              transform: transform
                ? `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`
                : undefined
            }}
          />
        </div>
        {/* Why: bottom-right keeps the controls clear of the window controls and traffic lights at the top. */}
        <div className="absolute right-4 bottom-4 flex items-center gap-1 rounded-lg border border-border bg-popover/95 p-1 text-popover-foreground shadow-floating backdrop-blur">
          <span className="hidden px-2 text-xs text-muted-foreground md:inline">
            {translate(
              'auto.components.editor.MermaidDiagramLightbox.hint',
              'Scroll or +/− to zoom · Drag or arrow keys to pan'
            )}
          </span>
          <Separator orientation="vertical" className="mx-1 hidden h-4 md:block" />
          <ToolbarIconButton
            label={translate('auto.components.editor.MermaidDiagramLightbox.zoomOut', 'Zoom out')}
            shortcut="-"
            onClick={() => zoomAroundCenter(1 / DIAGRAM_BUTTON_ZOOM_STEP)}
          >
            <ZoomOut />
          </ToolbarIconButton>
          <span className="w-12 text-center text-xs text-muted-foreground tabular-nums">
            {zoomPercent}%
          </span>
          <ToolbarIconButton
            label={translate('auto.components.editor.MermaidDiagramLightbox.zoomIn', 'Zoom in')}
            shortcut="+"
            onClick={() => zoomAroundCenter(DIAGRAM_BUTTON_ZOOM_STEP)}
          >
            <ZoomIn />
          </ToolbarIconButton>
          <ToolbarIconButton
            label={translate('auto.components.editor.MermaidDiagramLightbox.fit', 'Fit to screen')}
            shortcut="0"
            onClick={fitToViewport}
          >
            <Maximize />
          </ToolbarIconButton>
          <Separator orientation="vertical" className="mx-1 h-4" />
          <DialogClose asChild>
            <ToolbarIconButton
              label={translate('auto.components.editor.MermaidDiagramLightbox.close', 'Close')}
            >
              <X />
            </ToolbarIconButton>
          </DialogClose>
        </div>
      </div>
    </>
  )
}

type ToolbarIconButtonProps = React.ComponentProps<typeof Button> & {
  label: string
  shortcut?: string
}

function ToolbarIconButton({
  label,
  shortcut,
  children,
  ...props
}: ToolbarIconButtonProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={label} {...props}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
        {shortcut && <ShortcutKeyCombo keys={[shortcut]} className="ml-1.5" />}
      </TooltipContent>
    </Tooltip>
  )
}
