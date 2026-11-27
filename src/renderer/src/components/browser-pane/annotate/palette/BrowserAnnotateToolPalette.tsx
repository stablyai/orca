import type { OverlayRectSource } from '../../describe-page/browser-annotation-geometry'
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { Crosshair, Hourglass, MessageSquarePlus, PenTool } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { BrowserAnnotateTool } from './use-browser-annotate-tool-switch'
import {
  PALETTE_EDGE_INSET_PX,
  PALETTE_HINT_LINE_PX,
  paletteRatioPercent,
  paletteTooltipOffset
} from './palette-placement'
import { usePaletteDrag } from './use-palette-drag'
import { usePaletteFitLevel } from './use-palette-fit-level'
import { usePaletteHintHeight } from './use-palette-hint-height'
import type { MarkupPaletteDensity } from './MarkupPaletteTools'
import {
  setAnnotatePalettePosition,
  useAnnotatePalettePopupSide,
  useAnnotatePalettePosition
} from './annotate-palette-position-store'
import { PaletteDoneButton, PaletteGrabActions, PaletteGrip } from './palette-controls'
import { usePaletteTopOffset } from './use-palette-top-offset'
import { useHoldAltSeeThrough } from './use-hold-alt-see-through'
import { useGrabLabelAvoidArea } from './use-grab-label-avoid-area'
import { focusAnnotateButtonNear, isEditableFocus, useToolLabelsFit } from './palette-focus-and-fit'

type ToolOption = {
  tool: BrowserAnnotateTool
  key: 'A' | 'G' | 'D'
  icon: LucideIcon
  label: string
  tooltip: string
}

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
  hintKeepsWhenCompact = false,
  annotateActions,
  grabCopyDone,
  grabPicked,
  grabCanScreenshot,
  onGrabCopy,
  onGrabScreenshot,
  onDrawSlotChange,
  onDrawDensityChange,
  labelAvoidFrameRef,
  unavailableReason,
  drawWaitingForPage = false,
  drawHasActions = false
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
  /** A status (an error, a limit, a wait) that stays shown when compaction drops the palette's tips. */
  hintKeepsWhenCompact?: boolean
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
  /** The page frame; while picking, the palette tells that page where it sits so hover labels avoid it. */
  labelAvoidFrameRef?: RefObject<OverlayRectSource | null>
  /** Why the other tools can't be used right now (e.g. the page didn't load); shown as their tooltip. */
  unavailableReason?: string
  drawWaitingForPage?: boolean
  drawHasActions?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const waitingAnnouncementRef = useRef<HTMLSpanElement>(null)
  const waitingMessage = t('browser.annotatePalette.waitingForPage', 'Waiting for page…')
  // Populate after mount so direct entry into loading Draw announces too.
  useEffect(() => {
    const region = waitingAnnouncementRef.current
    const message = drawWaitingForPage ? waitingMessage : ''
    if (region && region.textContent !== message) {
      region.textContent = message
    }
  }, [drawWaitingForPage, waitingMessage])
  const paletteRef = useRef<HTMLDivElement>(null)
  const toolRefs = useRef(new Map<BrowserAnnotateTool, HTMLButtonElement>())
  const labelProbeRef = useRef<HTMLSpanElement>(null)
  const hintRef = useRef<HTMLDivElement>(null)
  const focusingToolRef = useRef(false)
  const [openTooltip, setOpenTooltip] = useState<BrowserAnnotateTool | null>(null)
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
  const position = useAnnotatePalettePosition()
  const popupSide = useAnnotatePalettePopupSide()
  const [findBarMinTop, setFindBarMinTop] = useState(PALETTE_EDGE_INSET_PX)
  const [hintHeight, setHintHeight] = useState(PALETTE_HINT_LINE_PX)
  const { left, top, canMove, dragging, snapping, shownPosition, hintPlacement, gripProps } =
    usePaletteDrag({
      bounds,
      paletteRef,
      position,
      minTop: findBarMinTop,
      onPositionChange: setAnnotatePalettePosition,
      hintHeight
    })
  const seeThrough = useHoldAltSeeThrough(pageId)
  usePaletteTopOffset(bounds, paletteRef, labelProbeRef, left, setFindBarMinTop)

  const options: ToolOption[] = [
    {
      tool: 'copy',
      key: 'G',
      icon: Crosshair,
      label: t('browser.toolbar.grab', 'Grab'),
      tooltip: showKeyHints
        ? t('browser.annotatePalette.grabTooltip', "Grab: copy an element's context (G)")
        : t('browser.annotatePalette.grabTooltipNoKey', "Grab: copy an element's context")
    },
    {
      tool: 'annotate',
      key: 'A',
      icon: MessageSquarePlus,
      label: t('browser.toolbar.annotate', 'Annotate'),
      tooltip: showKeyHints
        ? t('browser.annotatePalette.annotateTooltip', 'Annotate: comment on an element (A)')
        : t('browser.annotatePalette.annotateTooltipNoKey', 'Annotate: comment on an element')
    },
    {
      tool: 'draw',
      key: 'D',
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
    // Draw's action row comes and goes with its screenshot; losing it may let fuller labels fit again.
    `${activeTool}|${showToolLabels}|${annotateActions ? 1 : 0}|${activeTool === 'draw' && drawHasActions ? 1 : 0}`
  )
  const discardsDrawing = activeTool === 'draw' && drawHasActions
  const shortActions = fitLevel >= FIT_LEVEL_SHORT_ACTIONS
  const wrapActions = fitLevel >= FIT_LEVEL_WRAP
  const showHint =
    Boolean(hint) && (fitLevel === 0 || hintKeepsWhenCompact) && !dragging && left !== null
  usePaletteHintHeight(hintRef, showHint, setHintHeight)
  const tooltipOffset = paletteTooltipOffset(showHint, hintPlacement, hintHeight, popupSide)
  const tooltipPlacement = { side: popupSide, sideOffset: tooltipOffset }
  const hasActions =
    activeTool === 'draw' ? drawHasActions : activeTool === 'copy' || annotateActions !== null
  useGrabLabelAvoidArea({
    pageId: ownerPageId,
    frameRef: labelAvoidFrameRef,
    paletteRef,
    hintRef,
    enabled: activeTool !== 'draw' && !dragging && left !== null,
    layoutKey: `${left}|${top}|${fitLevel}|${showHint ? hint : ''}|${activeTool}|${annotateActions ? 1 : 0}`
  })

  // Entry and tool changes focus the active tool, so A/G/D never type into the page and keep reaching the app
  // (Draw has no page picker to forward keys from). A comment draft being typed keeps its focus.
  // Why wait for placement: the palette stays invisible until it is measured, and an invisible button can't take focus.
  const placed = left !== null
  useLayoutEffect(() => {
    if (!placed) {
      return
    }
    const focused = document.activeElement
    if (focused instanceof HTMLElement && isEditableFocus(focused)) {
      return
    }
    // The palette moving focus itself must not open that tool's tooltip: an open tooltip takes the next Esc,
    // and Esc then seems to do nothing.
    focusingToolRef.current = true
    toolRefs.current.get(activeTool)?.focus({ preventScroll: true })
    focusingToolRef.current = false
  }, [activeTool, placed])

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

  const percent = paletteRatioPercent(shownPosition.x)
  const verticalPercent = paletteRatioPercent(shownPosition.y)
  return (
    <>
      <div
        ref={paletteRef}
        data-browser-annotate-palette
        data-browser-annotate-page={ownerPageId}
        role="group"
        aria-label={t('browser.annotatePalette.label', 'Annotate tools')}
        className={cn(
          // Frosted glass with a hairline and deep shadow, so it stands out over any page.
          'absolute z-40 flex w-max items-center gap-1 rounded-xl border border-black/14 bg-floating-surface p-1 text-xs text-popover-foreground shadow-[0_10px_27px_rgba(0,0,0,0.27),0_1px_2px_rgba(0,0,0,0.12)] backdrop-blur-[14px] backdrop-saturate-[1.4] transition-opacity duration-100 dark:border-white/16 dark:shadow-[0_10px_27px_rgba(0,0,0,0.27),0_1px_2px_rgba(0,0,0,0.12),inset_0_1px_0_rgba(255,255,255,0.08)]',
          seeThrough ? 'pointer-events-none opacity-15' : 'pointer-events-auto',
          snapping && 'transition-[left,top] duration-150 ease-out',
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
          className="order-1 flex shrink-0 items-center gap-1"
        >
          <span
            ref={labelProbeRef}
            aria-hidden
            className="pointer-events-none invisible absolute flex items-center gap-1 font-medium whitespace-nowrap"
          >
            {options.map((option) => (
              <span key={option.tool} className="flex h-6.5 items-center gap-1.5 px-2">
                <option.icon className="size-3.5" />
                {option.label}
              </span>
            ))}
          </span>
          {options.map((option) => {
            const checked = option.tool === activeTool
            const unavailable = !canPickElements && !checked
            const waiting = option.tool === 'draw' && drawWaitingForPage
            const Icon = waiting ? Hourglass : option.icon
            const accessibleLabel = waiting ? `${option.label} · ${waitingMessage}` : option.label
            return (
              <Tooltip
                key={option.tool}
                open={openTooltip === option.tool}
                onOpenChange={(open) => {
                  if (open && focusingToolRef.current) {
                    return
                  }
                  setOpenTooltip((current) =>
                    open ? option.tool : current === option.tool ? null : current
                  )
                }}
              >
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
                    aria-busy={waiting || undefined}
                    aria-label={accessibleLabel}
                    aria-keyshortcuts={showKeyHints ? option.key : undefined}
                    tabIndex={checked ? 0 : -1}
                    // aria-disabled, not disabled: a disabled button shows no tooltip, and this one says why.
                    aria-disabled={unavailable || undefined}
                    className={cn(
                      'flex h-6.5 items-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-popover focus-visible:outline-none aria-disabled:opacity-50',
                      showToolLabels
                        ? 'px-2'
                        : shortActions
                          ? 'w-6 justify-center'
                          : 'w-7 justify-center',
                      checked
                        ? 'bg-theme-accent-fill text-theme-accent-foreground shadow-[0_2px_8px_color-mix(in_srgb,var(--color-theme-accent-fill)_55%,transparent)]'
                        : 'text-popover-foreground/80 hover:bg-accent/70 hover:text-popover-foreground'
                    )}
                    onClick={() => {
                      if (!unavailable) {
                        onSelectTool(option.tool)
                      }
                    }}
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
                <TooltipContent data-annotate-palette-tooltip="" {...tooltipPlacement}>
                  {unavailable && unavailableReason
                    ? unavailableReason
                    : waiting
                      ? accessibleLabel
                      : option.tooltip}
                </TooltipContent>
              </Tooltip>
            )
          })}
        </div>
        {hasActions ? (
          <span
            className="order-1 mx-0.5 h-4 w-px shrink-0 bg-black/14 dark:bg-white/16"
            aria-hidden
          />
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
        <span
          className="order-1 mx-0.5 h-4 w-px shrink-0 bg-black/14 dark:bg-white/16"
          aria-hidden
        />
        <PaletteDoneButton
          discardsDrawing={discardsDrawing}
          onDone={onDone}
          tooltipOffset={tooltipOffset}
        />
        {/* Last in DOM so keyboard users reach the tools first; shown first visually. */}
        {/* Kept while dragging, so a resize that removes the room can't detach the grip mid-drag. */}
        {canMove || dragging ? (
          <PaletteGrip
            percent={percent}
            verticalPercent={verticalPercent}
            dragging={dragging}
            gripProps={gripProps}
            tooltipOffset={tooltipOffset}
          />
        ) : null}
      </div>
      {showHint ? (
        <div
          ref={hintRef}
          className={cn(
            'pointer-events-none absolute z-40 rounded-md break-words border border-black/14 bg-floating-surface px-2 py-0.5 text-2xs shadow-[0_1px_2px_rgba(0,0,0,0.12)] backdrop-blur-[14px] dark:border-white/16',
            'transition-opacity duration-100',
            seeThrough && 'opacity-15',
            hintIsError ? 'text-destructive' : 'text-popover-foreground/80'
          )}
          style={hintPlacement}
        >
          {hint}
        </div>
      ) : null}
      <span ref={waitingAnnouncementRef} className="sr-only" role="status" aria-live="polite" />
      {/* Polite announcements: the active tool, and errors from the picker. */}
      <span className="sr-only" role="status" aria-live="polite">
        {hintIsError ? hint : activeLabel}
      </span>
    </>
  )
}
