import { useRef, useState } from 'react'
import {
  Crosshair,
  ExternalLink,
  MessageSquarePlus,
  PenTool,
  Share2,
  SquareCode
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  BrowserNavigationControlRow,
  type BrowserNavigationControls
} from './browser-navigation-control-row'
import { MarkupDrawButton } from '../annotate/MarkupDrawButton'
import type {
  BrowserChromeFoldedTool,
  BrowserChromeOverflowMenuProps
} from './browser-chrome-folded-tools'
import {
  BROWSER_CHROME_FOLD_ORDER,
  useBrowserChromeToolFold,
  type BrowserChromeFoldStage
} from './use-browser-chrome-tool-fold'
import {
  BrowserChromeElementToolButtons,
  type BrowserChromeElementTools
} from './browser-chrome-element-tool-buttons'

export type { BrowserChromeElementTools } from './browser-chrome-element-tool-buttons'

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

export type BrowserChromeShareControl = {
  open: boolean
  onOpenChange: (open: boolean) => void
  anchorRef?: React.RefObject<HTMLButtonElement | null>
}

export type BrowserChromeToolAction = {
  onSelect: () => void
  label: string
  disabled?: boolean
  /** True when the surface's overflow menu already exposes this action. */
  alreadyInOverflowMenu?: boolean
}

function BrowserChromeActionButton({
  action,
  icon: Icon
}: {
  action: BrowserChromeToolAction
  icon: LucideIcon
}): React.JSX.Element {
  return (
    <Button
      size="icon"
      variant="ghost"
      className="h-7 w-7"
      onClick={action.onSelect}
      title={action.label}
      aria-label={action.label}
      disabled={action.disabled}
    >
      <Icon className="size-4" />
    </Button>
  )
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
  showTourAnchors = false,
  pinnedStage
}: {
  controls: BrowserNavigationControls
  addressSlot: React.ReactNode
  reloadControl?: React.ReactNode
  reloadLabel?: string
  /** Cookie import — a browsing session concept; null where there is no session to import into. */
  importControl?: ((compact: boolean) => React.ReactNode) | null
  elementTools: BrowserChromeElementTools | null
  markup: BrowserChromeMarkupTool
  shareControl?: (control: BrowserChromeShareControl) => React.ReactNode
  viewSource: BrowserChromeToolAction | null
  openExternal: BrowserChromeToolAction | null
  overflowMenu: (props: BrowserChromeOverflowMenuProps) => React.ReactNode
  /** Only the browsing pane anchors the contextual tour; a second anchor would steal its steps. */
  showTourAnchors?: boolean
  /** Keeps the active contextual-tour control measurable while the remaining tools still fold. */
  pinnedStage?: BrowserChromeFoldStage
}): React.JSX.Element {
  const rowRef = useRef<HTMLDivElement>(null)
  const overflowTriggerRef = useRef<HTMLButtonElement>(null)
  const present: Record<BrowserChromeFoldStage, boolean> = {
    'import-label': importControl != null,
    import: importControl != null,
    external: openExternal !== null,
    devtools: viewSource !== null,
    share: shareControl != null,
    draw: true,
    grab: elementTools !== null,
    annotate: elementTools !== null
  }
  const stages = BROWSER_CHROME_FOLD_ORDER.filter(
    (stage) => present[stage] && stage !== pinnedStage
  )
  const folded = useBrowserChromeToolFold(rowRef, stages)

  const [sharePopoverOpen, setSharePopoverOpen] = useState(false)
  const afterMenuCloseRef = useRef<(() => void) | null>(null)

  const foldedTools: BrowserChromeFoldedTool[] = []
  if (elementTools && folded.has('grab')) {
    foldedTools.push({
      stage: 'grab',
      label: translate('auto.components.browser.pane.BrowserPane.fdfc7fe0ef', 'Grab page element'),
      icon: Crosshair,
      onSelect: () => elementTools.onStartIntent('copy'),
      disabled: elementTools.disabled,
      shortcut: elementTools.grabShortcutLabel,
      active: elementTools.activeIntent === 'copy'
    })
  }
  if (elementTools && folded.has('annotate')) {
    foldedTools.push({
      stage: 'annotate',
      label: translate(
        'auto.components.browser.pane.BrowserPane.fc9be38f6f',
        'Annotate page element'
      ),
      icon: MessageSquarePlus,
      onSelect: () => elementTools.onStartIntent('annotate'),
      disabled: elementTools.disabled,
      count: elementTools.annotationCount,
      active: elementTools.activeIntent === 'annotate'
    })
  }
  if (folded.has('draw')) {
    foldedTools.push({
      stage: 'draw',
      label: translate('auto.components.browser-pane.markup.drawButton', 'Draw on screenshot'),
      icon: PenTool,
      onSelect: markup.onToggle,
      disabled: markup.disabled,
      active: markup.active
    })
  }
  if (shareControl && folded.has('share')) {
    foldedTools.push({
      stage: 'share',
      label: translate(
        'auto.components.artifacts.ArtifactPublishButton.a4a49da6af',
        'Share as artifact'
      ),
      icon: Share2,
      onSelect: () => setSharePopoverOpen(true),
      deferUntilMenuClose: true
    })
  }
  if (viewSource && folded.has('devtools') && !viewSource.alreadyInOverflowMenu) {
    foldedTools.push({ stage: 'devtools', icon: SquareCode, ...viewSource })
  }
  if (openExternal && folded.has('external') && !openExternal.alreadyInOverflowMenu) {
    foldedTools.push({ stage: 'external', icon: ExternalLink, ...openExternal })
  }

  const runAfterMenuClose = (action: () => void): void => {
    afterMenuCloseRef.current = action
  }
  const onMenuCloseAutoFocus = (event: Event): void => {
    const action = afterMenuCloseRef.current
    if (!action) {
      return
    }
    afterMenuCloseRef.current = null
    event.preventDefault()
    action()
  }
  const showFoldedAnnotationDot = folded.has('annotate') && (elementTools?.annotationCount ?? 0) > 0

  return (
    <BrowserNavigationControlRow
      rowRef={rowRef}
      controls={controls}
      addressSlot={addressSlot}
      reloadControl={reloadControl}
      reloadLabel={reloadLabel}
      showTourAnchors={showTourAnchors}
    >
      {folded.has('import') ? null : importControl?.(folded.has('import-label'))}

      {elementTools ? (
        <BrowserChromeElementToolButtons
          tools={elementTools}
          showGrab={!folded.has('grab')}
          showAnnotate={!folded.has('annotate')}
          showTourAnchors={showTourAnchors}
        />
      ) : null}

      {folded.has('draw') ? null : (
        <MarkupDrawButton
          onClick={markup.onToggle}
          disabled={markup.disabled}
          active={markup.active}
          surfaceActive={markup.canShowDiscoveryHint}
        />
      )}

      {shareControl?.({
        open: sharePopoverOpen,
        onOpenChange: setSharePopoverOpen,
        anchorRef: folded.has('share') ? overflowTriggerRef : undefined
      })}

      {viewSource && !folded.has('devtools') ? (
        <BrowserChromeActionButton action={viewSource} icon={SquareCode} />
      ) : null}

      {openExternal && !folded.has('external') ? (
        <BrowserChromeActionButton action={openExternal} icon={ExternalLink} />
      ) : null}

      <span className="relative inline-flex">
        {overflowMenu({
          triggerRef: overflowTriggerRef,
          tools: foldedTools,
          deferUntilClose: runAfterMenuClose,
          onMenuCloseAutoFocus
        })}
        {/* Why: keeps pending annotations visible once the annotate button has folded into ⋯. */}
        {showFoldedAnnotationDot ? (
          <span className="pointer-events-none absolute top-1 right-1 size-1.5 rounded-full bg-primary ring-2 ring-background" />
        ) : null}
      </span>
    </BrowserNavigationControlRow>
  )
}
