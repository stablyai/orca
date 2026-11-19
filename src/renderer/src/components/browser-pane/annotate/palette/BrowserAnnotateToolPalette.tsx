import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Crosshair, MessageSquarePlus, PenTool, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BrowserAnnotateTool } from './use-browser-annotate-tool-switch'
import {
  PALETTE_EDGE_INSET_PX,
  paletteRatioPercent,
  usePaletteHorizontalDrag
} from './use-palette-horizontal-drag'
import { usePaletteFitLevel } from './use-palette-fit-level'
import type { MarkupPaletteDensity } from './MarkupPaletteTools'
import { setAnnotatePaletteRatio, useAnnotatePaletteRatio } from './annotate-palette-position-store'
import { PaletteGrabActions, PaletteGrip } from './palette-controls'
import { usePaletteTopOffset } from './use-palette-top-offset'
import { useHoldAltSeeThrough } from './use-hold-alt-see-through'
import { focusAnnotateButtonNear, isEditableFocus, useToolLabelsFit } from './palette-focus-and-fit'

type ToolOption = {
  tool: BrowserAnnotateTool
  icon: LucideIcon
  label: string
  tooltip: string
}

/** Steps applied in order until the palette fits: short action labels, then let actions wrap. */
/** Fit steps, in order: Draw folds its tools into ⋯, then short labels with a minimal Draw row, then wrap. */
const FIT_LEVEL_DRAW_ROW = 1
const FIT_LEVEL_SHORT_ACTIONS = 2
const FIT_LEVEL_WRAP = 3
/**
 * Floating tool switch over the page while Annotate, Grab or Draw is on.
 * Why floating and draggable: every tool stays visible, and the user slides it off whatever they want to pick.
 */
export function BrowserAnnotateToolPalette({
  boundsRef,
  pageId,
  ownerPageId,
  activeTool,
  onSelectTool,
  onDone,
  canPickElements,
  showKeyHints,
  hint,
  hintIsError,
  annotateActions,
  grabCopyDone,
  grabPicked,
  grabCanScreenshot,
  onGrabCopy,
  onGrabScreenshot,
  onDrawSlotChange,
  onDrawDensityChange
}: {
  /** The page area the palette floats over and may not leave. */
  boundsRef: RefObject<HTMLElement | null>
  /** The page whose forwarded Alt key fades the palette; null where the page forwards no keys. */
  pageId: string | null
  /** The page this palette belongs to; key and Esc owners use it to ignore other panes' palettes. */
  ownerPageId: string
  activeTool: BrowserAnnotateTool
  onSelectTool: (tool: BrowserAnnotateTool) => void
  onDone: () => void
  canPickElements: boolean
  /** Only where the A/G/D keys are wired; tooltips name them then. */
  showKeyHints: boolean
  hint: string
  hintIsError: boolean
  /** Notes and Send while Annotate is on; null with no notes. */
  annotateActions: ((short: boolean) => React.ReactNode) | null
  /** Grab just copied: Copy shows a check. */
  grabCopyDone: boolean
  /** An element is picked; Copy and Screenshot act on it (C and S still act on the hovered element). */
  grabPicked: boolean
  grabCanScreenshot: boolean
  onGrabCopy: () => void
  onGrabScreenshot: () => void
  /** Draw's markup tools render into this slot. */
  onDrawSlotChange: (slot: HTMLElement | null) => void
  /** Narrow palette: Draw keeps Pen and the selected tool and a short Copy, before anything wraps. */
  onDrawDensityChange: (density: MarkupPaletteDensity) => void
}): React.JSX.Element {
  const t = useTranslate()
  const paletteRef = useRef<HTMLDivElement>(null)
  const toolRefs = useRef(new Map<BrowserAnnotateTool, HTMLButtonElement>())
  const labelProbeRef = useRef<HTMLSpanElement>(null)
  // Why state: the hooks below must re-run once the page area is attached, which can be after this mounts.
  const [bounds, setBounds] = useState<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (boundsRef.current) {
      setBounds(boundsRef.current)
      return
    }
    const frame = requestAnimationFrame(() => setBounds(boundsRef.current))
    return () => cancelAnimationFrame(frame)
  }, [boundsRef])
  // Read here, not by the always-mounted overlays, so no page subscribes while its palette is closed.
  const ratio = useAnnotatePaletteRatio()
  const { left, canMove, dragging, snapping, shownRatio, gripProps } = usePaletteHorizontalDrag({
    bounds,
    paletteRef,
    ratio,
    onRatioChange: setAnnotatePaletteRatio
  })
  const seeThrough = useHoldAltSeeThrough(pageId)
  const top = usePaletteTopOffset(bounds, paletteRef, left)

  const options: ToolOption[] = [
    {
      tool: 'annotate',
      icon: MessageSquarePlus,
      label: t('browser.toolbar.annotate', 'Annotate'),
      tooltip: showKeyHints
        ? t('browser.annotatePalette.annotateTooltip', 'Annotate: comment on an element (A)')
        : t('browser.annotatePalette.annotateTooltipNoKey', 'Annotate: comment on an element')
    },
    {
      tool: 'copy',
      icon: Crosshair,
      label: t('browser.toolbar.grab', 'Grab'),
      tooltip: showKeyHints
        ? t('browser.annotatePalette.grabTooltip', "Grab: copy an element's context (G)")
        : t('browser.annotatePalette.grabTooltipNoKey', "Grab: copy an element's context")
    },
    {
      tool: 'draw',
      icon: PenTool,
      label: t('browser.toolbar.draw', 'Draw'),
      tooltip: showKeyHints
        ? t('browser.annotatePalette.drawTooltip', 'Draw: mark up a screenshot (D)')
        : t('browser.annotatePalette.drawTooltipNoKey', 'Draw: mark up a screenshot')
    }
  ]
  const activeLabel = options.find((option) => option.tool === activeTool)?.label ?? ''

  const showToolLabels = useToolLabelsFit(bounds, labelProbeRef)
  const fitLevel = usePaletteFitLevel(
    paletteRef,
    bounds,
    `${activeTool}|${showToolLabels}|${annotateActions ? 1 : 0}`
  )
  const shortActions = fitLevel >= FIT_LEVEL_SHORT_ACTIONS
  const wrapActions = fitLevel >= FIT_LEVEL_WRAP
  const showHint = Boolean(hint) && fitLevel === 0 && !dragging && left !== null
  const hasActions = activeTool !== 'annotate' || annotateActions !== null

  // Entry and tool changes focus the active tool, so A/G/D never type into the page and keep reaching the app
  // (Draw has no page picker to forward keys from). A comment draft being typed keeps its focus.
  useLayoutEffect(() => {
    const focused = document.activeElement
    if (focused instanceof HTMLElement && isEditableFocus(focused)) {
      return
    }
    toolRefs.current.get(activeTool)?.focus({ preventScroll: true })
  }, [activeTool])

  useLayoutEffect(() => {
    const palette = paletteRef.current
    return () => {
      // Exit hands focus back to the toolbar button when it was inside the palette.
      if (palette && palette.contains(document.activeElement)) {
        focusAnnotateButtonNear(palette)
      }
    }
  }, [])

  const [drawSlot, setDrawSlot] = useState<HTMLDivElement | null>(null)
  useEffect(() => {
    onDrawSlotChange(activeTool === 'draw' ? drawSlot : null)
  }, [activeTool, drawSlot, onDrawSlotChange])
  useEffect(() => () => onDrawSlotChange(null), [onDrawSlotChange])
  useEffect(() => {
    onDrawDensityChange(shortActions ? 'compact' : fitLevel >= FIT_LEVEL_DRAW_ROW ? 'row' : 'full')
  }, [fitLevel, onDrawDensityChange, shortActions])

  // Arrows only move focus: selecting Draw captures the page and switching intent drops a pick, so a tool
  // changes only on an explicit click, Space/Enter or its letter key.
  const moveFocus = (from: BrowserAnnotateTool, step: number): void => {
    const index = options.findIndex((option) => option.tool === from)
    const next = options[(index + step + options.length) % options.length]
    toolRefs.current.get(next.tool)?.focus()
  }

  const percent = paletteRatioPercent(shownRatio)
  return (
    <>
      <div
        ref={paletteRef}
        data-browser-annotate-palette
        data-browser-annotate-page={ownerPageId}
        role="group"
        aria-label={t('browser.annotatePalette.label', 'Annotate tools')}
        className={cn(
          'absolute z-40 flex w-max items-center gap-1 rounded-lg border border-border bg-popover/95 p-1 text-xs text-popover-foreground backdrop-blur transition-opacity duration-100',
          seeThrough ? 'pointer-events-none opacity-15' : 'pointer-events-auto',
          'shadow-floating',
          snapping && 'transition-[left] duration-150 ease-out',
          left === null && 'invisible'
        )}
        style={{
          left: left ?? 0,
          top,
          maxWidth: `calc(100% - ${PALETTE_EDGE_INSET_PX * 2}px)`
        }}
      >
        {/* Toggle buttons, not radios: arrows only move focus here, since selecting Draw captures the page. */}
        <div
          role="group"
          aria-label={t('browser.annotatePalette.tools', 'Tool')}
          className="order-1 flex shrink-0 items-center gap-0.5"
        >
          <span
            ref={labelProbeRef}
            aria-hidden
            className="pointer-events-none invisible absolute flex items-center gap-0.5 font-medium whitespace-nowrap"
          >
            {options.map((option) => (
              <span key={option.tool} className="flex h-7 items-center gap-1.5 px-2">
                <option.icon className="size-3.5" />
                {option.label}
              </span>
            ))}
          </span>
          {options.map((option) => {
            const checked = option.tool === activeTool
            const Icon = option.icon
            return (
              <Tooltip key={option.tool}>
                <TooltipTrigger asChild>
                  <button
                    ref={(node) => {
                      if (node) {
                        toolRefs.current.set(option.tool, node)
                      } else {
                        toolRefs.current.delete(option.tool)
                      }
                    }}
                    type="button"
                    aria-pressed={checked}
                    aria-label={option.label}
                    aria-keyshortcuts={
                      !showKeyHints
                        ? undefined
                        : option.tool === 'annotate'
                          ? 'A'
                          : option.tool === 'copy'
                            ? 'G'
                            : 'D'
                    }
                    tabIndex={checked ? 0 : -1}
                    disabled={!canPickElements && !checked}
                    className={cn(
                      'flex h-7 items-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50',
                      showToolLabels
                        ? 'px-2'
                        : shortActions
                          ? 'w-6 justify-center'
                          : 'w-7 justify-center',
                      checked
                        ? 'bg-accent text-foreground ring-1 ring-muted-foreground ring-inset'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
                    )}
                    onClick={() => onSelectTool(option.tool)}
                    onKeyDown={(event) => {
                      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                        event.preventDefault()
                        moveFocus(option.tool, event.key === 'ArrowRight' ? 1 : -1)
                      }
                    }}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    {showToolLabels ? <span>{option.label}</span> : null}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={6}>
                  {option.tooltip}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
        {hasActions ? (
          <span className="order-1 mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
        ) : null}
        {/* Why shrink-0 until the last step: overflow must show in the palette's width so the fit steps can see it;
            only when every step is used may the actions wrap onto a second line instead of overlapping Done. */}
        <div
          className={cn(
            'order-1 flex items-center gap-1',
            wrapActions ? 'min-w-0 flex-wrap' : 'shrink-0'
          )}
        >
          {activeTool === 'annotate' && annotateActions ? annotateActions(shortActions) : null}
          {activeTool === 'copy' ? (
            <PaletteGrabActions
              short={shortActions}
              copyDone={grabCopyDone}
              picked={grabPicked}
              canScreenshot={grabCanScreenshot}
              onCopy={onGrabCopy}
              onScreenshot={onGrabScreenshot}
            />
          ) : null}
          {activeTool === 'draw' ? (
            <div ref={setDrawSlot} className="flex min-w-0 flex-wrap items-center" />
          ) : null}
        </div>
        <span className="order-1 mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="icon-xs"
              variant="ghost"
              className="order-1 size-7 shrink-0"
              onClick={onDone}
              aria-label={t('browser.annotatePalette.done', 'Done')}
              aria-keyshortcuts="Escape"
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {t('browser.annotatePalette.doneTitle', 'Done (Esc)')}
          </TooltipContent>
        </Tooltip>
        {/* Last in DOM so keyboard users reach the tools first; shown first visually. */}
        {/* Kept while dragging, so a resize that removes the room can't detach the grip mid-drag. */}
        {canMove || dragging ? (
          <PaletteGrip percent={percent} dragging={dragging} gripProps={gripProps} />
        ) : null}
      </div>
      {showHint ? (
        <div
          className={cn(
            'pointer-events-none absolute z-40 max-w-[calc(100%-16px)] truncate rounded-md border border-border bg-popover/95 px-2 py-0.5 text-2xs backdrop-blur',
            'transition-opacity duration-100',
            seeThrough && 'opacity-15',
            hintIsError ? 'text-destructive' : 'text-muted-foreground'
          )}
          style={{ left: left ?? 0, top: top + 38 + 8 }}
        >
          {hint}
        </div>
      ) : null}
      {/* Polite announcements: the active tool, and errors from the picker. */}
      <span className="sr-only" role="status" aria-live="polite">
        {hintIsError ? hint : activeLabel}
      </span>
    </>
  )
}
