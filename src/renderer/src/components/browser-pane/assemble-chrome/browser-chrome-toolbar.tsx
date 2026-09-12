import { cn } from '@/lib/utils'
import { Crosshair, ExternalLink, MessageSquarePlus, SquareCode } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import {
  BrowserNavigationControlRow,
  type BrowserNavigationControls
} from './browser-navigation-control-row'
import { MarkupDrawButton } from '../annotate/MarkupDrawButton'
import type { GrabIntent } from '../describe-page/browser-page-types'

/** The in-guest element picker, driving both Grab (copy) and Annotate (comment). */
export type BrowserChromeElementTools = {
  /** The intent the picker is armed for right now, or null when it is idle. */
  activeIntent: GrabIntent | null
  onStartIntent: (intent: GrabIntent) => void
  disabled: boolean
  grabShortcutLabel: string
  annotationCount: number
}

export type BrowserChromeMarkupTool = {
  active: boolean
  disabled: boolean
  onToggle: () => void
  /**
   * Whether this surface may spend the draw tool's one-per-install discovery popover. False on a
   * hidden pane (a portaled layer would anchor to a zero-size trigger) and false on any surface
   * that does not own the nudge — a preview consuming it would burn the single view on a reader
   * who came for a document, before the browsing pane ever offered it.
   */
  canShowDiscoveryHint: boolean
}

export type BrowserChromeToolAction = {
  onSelect: () => void
  label: string
  disabled?: boolean
}

/**
 * The whole browser chrome bar — history, identity, tools — for every surface that renders guest
 * content: the browsing pane and the workspace document preview.
 *
 * Why one component and not a shared row plus two tool clusters: a tool added here has to appear
 * on both surfaces to stay honest, and a per-surface cluster is exactly how they drift apart. A
 * surface omits a tool only by passing null, and each null below says why that tool cannot apply.
 */
export function BrowserChromeToolbar({
  controls,
  addressSlot,
  reloadControl,
  reloadLabel,
  importControl,
  elementTools,
  markup,
  shareControl,
  viewSource,
  openExternal,
  overflowMenu,
  showTourAnchors = false
}: {
  controls: BrowserNavigationControls
  addressSlot: React.ReactNode
  reloadControl?: React.ReactNode
  reloadLabel?: string
  /** Cookie import — a browsing session concept; null where there is no session to import into. */
  importControl?: React.ReactNode
  elementTools: BrowserChromeElementTools | null
  markup: BrowserChromeMarkupTool
  shareControl?: React.ReactNode
  viewSource: BrowserChromeToolAction | null
  openExternal: BrowserChromeToolAction | null
  overflowMenu?: React.ReactNode
  /** Only the browsing pane anchors the contextual tour; a second anchor would steal its steps. */
  showTourAnchors?: boolean
}): React.JSX.Element {
  return (
    <BrowserNavigationControlRow
      controls={controls}
      addressSlot={addressSlot}
      reloadControl={reloadControl}
      reloadLabel={reloadLabel}
      showTourAnchors={showTourAnchors}
    >
      {importControl}

      {elementTools ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  size="icon"
                  variant={elementTools.activeIntent === 'copy' ? 'default' : 'ghost'}
                  className={cn(
                    'h-8 w-8',
                    elementTools.activeIntent === 'copy' &&
                      'bg-foreground/80 text-background hover:bg-foreground/90'
                  )}
                  onClick={() => elementTools.onStartIntent('copy')}
                  disabled={elementTools.disabled}
                  aria-label={translate(
                    'auto.components.browser.pane.BrowserPane.fdfc7fe0ef',
                    'Grab page element'
                  )}
                  {...(showTourAnchors
                    ? { 'data-contextual-tour-target': 'browser-grab-control' }
                    : {})}
                >
                  <Crosshair className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {translate(
                'auto.components.browser.pane.BrowserPane.acbe79fd01',
                'Grab page element ({{value0}})',
                { value0: elementTools.grabShortcutLabel }
              )}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              {/* Why: disabled <button> drops hover events, so wrap in a span so the tooltip trigger still fires. */}
              <span className="inline-flex">
                <Button
                  size="icon"
                  variant={elementTools.activeIntent === 'annotate' ? 'default' : 'ghost'}
                  className={cn(
                    'relative h-8 w-8',
                    elementTools.activeIntent === 'annotate' &&
                      'bg-foreground/80 text-background hover:bg-foreground/90'
                  )}
                  onClick={() => elementTools.onStartIntent('annotate')}
                  disabled={elementTools.disabled}
                  aria-label={translate(
                    'auto.components.browser.pane.BrowserPane.fc9be38f6f',
                    'Annotate page element'
                  )}
                  {...(showTourAnchors
                    ? { 'data-contextual-tour-target': 'browser-annotation-control' }
                    : {})}
                >
                  <MessageSquarePlus className="size-4" />
                  {elementTools.annotationCount > 0 ? (
                    <span className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
                      {elementTools.annotationCount}
                    </span>
                  ) : null}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {translate(
                'auto.components.browser.pane.BrowserPane.fc9be38f6f',
                'Annotate page element'
              )}
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}

      <MarkupDrawButton
        onClick={markup.onToggle}
        disabled={markup.disabled}
        active={markup.active}
        surfaceActive={markup.canShowDiscoveryHint}
      />

      {shareControl}

      {viewSource ? (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={viewSource.onSelect}
          title={viewSource.label}
          aria-label={viewSource.label}
          disabled={viewSource.disabled}
        >
          <SquareCode className="size-4" />
        </Button>
      ) : null}

      {openExternal ? (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={openExternal.onSelect}
          title={openExternal.label}
          aria-label={openExternal.label}
          disabled={openExternal.disabled}
        >
          <ExternalLink className="size-4" />
        </Button>
      ) : null}

      {overflowMenu}
    </BrowserNavigationControlRow>
  )
}
