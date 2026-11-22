import { useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  BrowserNavigationControlRow,
  type BrowserNavigationControls
} from './browser-navigation-control-row'
import { useBrowserChromeToolFold } from './use-browser-chrome-tool-fold'
import {
  BrowserAnnotateToolButton,
  BrowserAnnotateToolMenuItems,
  type BrowserChromeElementTools,
  type BrowserChromeMarkupTool,
  type BrowserChromeNoteActions
} from './browser-annotate-tool-button'
import { useFloatingSplitBrowserClose } from './use-floating-split-browser-close'
import { MarkupDrawButton } from '../../annotate/markup-tools/MarkupDrawButton'

export type BrowserChromeToolAction = {
  onSelect: () => void
  label: string
  disabled?: boolean
}

export type BrowserChromeOverflowMenuProps = {
  triggerRef: React.RefObject<HTMLButtonElement | null>
  /** Run after menu close without focus return; focusing the ⋯ trigger would immediately dismiss a new popover or dialog. */
  deferUntilClose: (action: () => void) => void
  onMenuCloseAutoFocus: (event: Event) => void
  /** Grab and Draw, which the annotate icon otherwise shows only on right-click. */
  annotateToolItems: React.ReactNode
}

/**
 * One row for browsing and document previews: navigation, the address, one agent tool and ⋯.
 * Page actions live in the address slot; browser actions live in each surface's ⋯ menu.
 */
export function BrowserChromeToolbar({
  controls,
  addressSlot,
  reloadControl,
  reloadLabel,
  extensionActions,
  elementTools,
  markup,
  notes,
  shareControl,
  overflowMenu,
  closeTabOwner,
  showTourAnchors = false
}: {
  controls: BrowserNavigationControls
  addressSlot: React.ReactNode
  reloadControl?: React.ReactNode
  reloadLabel?: string
  /** Pinned extension buttons; null where the page's session runs no extensions. `compact` hides them, and unpinned popups anchor to ⋯. */
  extensionActions?:
    | ((
        compact: boolean,
        menuTriggerRef: React.RefObject<HTMLButtonElement | null>
      ) => React.ReactNode)
    | null
  /** Null where the page can't run the element picker; the row then offers Draw alone. */
  elementTools: BrowserChromeElementTools | null
  markup: BrowserChromeMarkupTool
  notes?: BrowserChromeNoteActions | null
  /** Share beside a document chip, which can't hold a nested button the way the address field does. */
  shareControl?: React.ReactNode
  overflowMenu: (props: BrowserChromeOverflowMenuProps) => React.ReactNode
  /** The page whose tab the toolbar X closes in a floating split, where the panel's one tab row may be showing another split. */
  closeTabOwner: { worktreeId: string; browserPageId: string }
  /** Only the browsing pane anchors the contextual tour; a second anchor would steal its steps. */
  showTourAnchors?: boolean
}): React.JSX.Element {
  const closeTab = useFloatingSplitBrowserClose(
    closeTabOwner.worktreeId,
    closeTabOwner.browserPageId
  )
  const rowRef = useRef<HTMLDivElement>(null)
  const overflowTriggerRef = useRef<HTMLButtonElement>(null)
  const folded = useBrowserChromeToolFold(rowRef, extensionActions == null ? [] : ['extensions'])

  const afterMenuCloseRef = useRef<(() => void) | null>(null)
  const deferUntilClose = (action: () => void): void => {
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

  return (
    <BrowserNavigationControlRow
      pageId={closeTabOwner.browserPageId}
      rowRef={rowRef}
      controls={controls}
      addressSlot={addressSlot}
      reloadControl={reloadControl}
      reloadLabel={reloadLabel}
      showTourAnchors={showTourAnchors}
    >
      {shareControl}
      {elementTools ? (
        <BrowserAnnotateToolButton
          tools={elementTools}
          markup={markup}
          notes={notes}
          showTourAnchors={showTourAnchors}
        />
      ) : (
        <MarkupDrawButton
          onClick={markup.onToggle}
          disabled={markup.disabled}
          active={markup.active}
          surfaceActive={markup.canShowDiscoveryHint}
        />
      )}
      <span className="flex shrink-0 items-center">
        {extensionActions?.(folded.has('extensions'), overflowTriggerRef)}
        {overflowMenu({
          triggerRef: overflowTriggerRef,
          deferUntilClose,
          onMenuCloseAutoFocus,
          annotateToolItems: <BrowserAnnotateToolMenuItems tools={elementTools} markup={markup} />
        })}
      </span>
      {closeTab ? (
        <>
          <span className="mx-0.5 h-4 w-px shrink-0 bg-border" aria-hidden />
          <Button
            size="icon-xs"
            variant="muted-field-icon"
            onClick={closeTab.onSelect}
            title={closeTab.label}
            aria-label={closeTab.label}
            disabled={closeTab.disabled}
          >
            <X className="size-3.5" />
          </Button>
        </>
      ) : null}
    </BrowserNavigationControlRow>
  )
}
