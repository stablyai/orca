import { useEffect, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { X, ExternalLink, Copy, CopyX, Pin, PinOff, Volume2, VolumeX } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TabHoverCard } from './TabHoverCard'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
import type { BrowserTab as BrowserTabState } from '../../../../shared/browser-workspace-types'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/close-all-context-menus'
import { getLiveBrowserUrl } from '../browser-pane/describe-page/live-browser-url-registry'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getDropIndicatorClasses,
  getTabRootStateClasses,
  getTabStripBorderClasses,
  type DropIndicator
} from './drop-indicator'
import { preventMiddleButtonDefault } from './middle-button-default-guard'
import { translate } from '@/i18n/i18n'
import { TAB_LABEL_WIDTH_CLASSES, TAB_ROOT_WIDTH_CLASSES } from './tab-width-rules'
import { useTabStripSlotProps } from './use-tab-strip-slot-props'
import { TabWorkspaceLayoutMenuSection } from './TabWorkspaceLayoutMenuSection'
import { useTabStripPointerActivation } from './tab-strip-pointer-activation'
import { TAB_CONTEXT_MENU_CONTENT_CLASS } from './tab-context-menu-sizing'
import { cn } from '@/lib/utils'
import { BrowserFavicon } from '@/components/browser-favicon'
import { AgentCursorGlyph } from '../browser-pane/agent-cursor/agent-cursor-glyph'
import { useBrowserAgentDrivesAnyPage } from '../browser-pane/agent-cursor/browser-agent-activity-state'
import { CopyTabIdMenuItem } from './CopyTabIdMenuItem'
import { CloseSplitPaneMenuItem } from './CloseSplitPaneMenuItem'
import { useAppStore } from '@/store'

export function formatBrowserTabUrlLabel(url: string): string {
  if (url === ORCA_BROWSER_BLANK_URL || url === 'about:blank') {
    return 'New Tab'
  }
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`
  } catch {
    return url
  }
}

export function getBrowserTabLabel(tab: BrowserTabState): string {
  if (
    !tab.title ||
    tab.title === tab.url ||
    tab.title === ORCA_BROWSER_BLANK_URL ||
    tab.title === 'about:blank'
  ) {
    return formatBrowserTabUrlLabel(tab.url)
  }
  return tab.title || tab.url
}

function isBlankBrowserTab(tab: BrowserTabState): boolean {
  return tab.url === ORCA_BROWSER_BLANK_URL || tab.url === 'about:blank'
}

export default function BrowserTab({
  tab,
  isActive,
  isPinned,
  hasTabsToRight,
  tabCount,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseSplitPane,
  onDuplicate,
  onTogglePin,
  dragData,
  dropIndicator,
  includeTopTabBorder = true
}: {
  tab: BrowserTabState
  isActive: boolean
  isPinned: boolean
  hasTabsToRight: boolean
  hasTabsToLeft: boolean
  tabCount: number
  onActivate: () => void
  onClose: () => void
  onCloseOthers: () => void
  onCloseToRight: () => void
  onCloseToLeft: () => void
  onCloseSplitPane?: () => void
  onDuplicate?: () => void
  onTogglePin: () => void
  dragData: TabDragItemData
  dropIndicator?: DropIndicator
  includeTopTabBorder?: boolean
}): React.JSX.Element {
  // Keep dragged tabs anchored; only the insertion bar moves.
  const { attributes, listeners, setNodeRef } = useSortable({
    id: tab.id,
    data: dragData
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })

  // Only HTTP(S) URLs can open in the system browser; disable unsupported or malformed destinations.
  const openInBrowserUrl = redactKagiSessionToken(getLiveBrowserUrl(tab.id) ?? tab.url)
  let isHttpUrl = false
  try {
    const parsed = new URL(openInBrowserUrl)
    isHttpUrl = parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    // invalid URL — leave disabled
  }
  const tabLabel = getBrowserTabLabel(tab)
  const audible = useAppStore((s) =>
    (s.browserPagesByWorkspace[tab.id] ?? []).some((page) => s.browserAudiblePageIds[page.id])
  )
  const audioMuted = useAppStore((s) => Boolean(s.browserAudioMutedTabIds[tab.id]))
  // Why: a muted tab keeps its icon after sound stops, so it can be unmuted from the strip.
  const showAudioControl = audible || audioMuted
  const setBrowserTabAudioMuted = useAppStore((s) => s.setBrowserTabAudioMuted)
  const toggleAudioMutedLabel = audioMuted
    ? translate('components.tab.bar.BrowserTab.unmuteTab', 'Unmute Tab')
    : translate('components.tab.bar.BrowserTab.muteTab', 'Mute Tab')
  const agentDriving = useBrowserAgentDrivesAnyPage(tab.pageIds ?? [tab.activePageId])
  const agentDrivingLabel = translate('browserTab.agentDriving', 'An agent is using this page')

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  // Webview clicks bypass renderer pointerdown, so window blur dismisses menus Radix cannot detect as outside clicks.
  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const dismiss = (): void => setMenuOpen(false)
    window.addEventListener('blur', dismiss)
    return () => window.removeEventListener('blur', dismiss)
  }, [menuOpen])

  // Activate on pointer-up so drag gestures cannot switch tabs mid-drag.
  const { onPointerDown: onTabPointerDown } = useTabStripPointerActivation({ onActivate })
  const slotProps = useTabStripSlotProps(tab.id, isActive)

  const tabRoot = (
    <div
      ref={setNodeRef}
      data-tab-id={tab.id}
      data-active={isActive ? 'true' : 'false'}
      data-pinned={isPinned ? 'true' : 'false'}
      {...attributes}
      {...listeners}
      className={`${TAB_ROOT_WIDTH_CLASSES} group relative flex items-center h-full px-1.5 text-xs cursor-pointer select-none outline-none focus:outline-none focus-visible:outline-none ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: includeTopTabBorder })} ${getDropIndicatorClasses(dropIndicator ?? null)} ${getTabRootStateClasses(isActive)}`}
      onPointerDown={(e) => {
        onTabPointerDown(
          e,
          listeners?.onPointerDown as ((event: React.PointerEvent<Element>) => void) | undefined
        )
      }}
      onMouseDown={(e) => {
        if (e.button === 1) {
          e.preventDefault()
        }
      }}
      onMouseUp={preventMiddleButtonDefault}
      onAuxClick={(e) => {
        if (e.button === 1) {
          e.preventDefault()
          e.stopPropagation()
          if (isPinned) {
            return
          }
          onClose()
        }
      }}
    >
      {isActive && <span className={ACTIVE_TAB_INDICATOR_CLASSES} aria-hidden />}
      {/* Keep browser identity distinct on inactive tabs too; muted icons look disabled. */}
      {agentDriving ? (
        // Why: the dimmed favicon keeps the site recognizable under the agent's arrow.
        <span role="img" aria-label={agentDrivingLabel} className="relative mr-1 size-3 shrink-0">
          <BrowserFavicon
            faviconUrl={tab.faviconUrl}
            className="size-3 opacity-30"
            fallbackClassName="text-blue-500"
          />
          <AgentCursorGlyph className="pointer-events-none absolute inset-0 size-3" />
        </span>
      ) : (
        <BrowserFavicon
          faviconUrl={tab.faviconUrl}
          loading={tab.loading && !tab.loadError && !isBlankBrowserTab(tab)}
          className="size-3 mr-1"
          fallbackClassName="text-blue-500"
        />
      )}
      {isPinned && <Pin className="mr-1 size-3 shrink-0 text-muted-foreground" aria-hidden />}
      <span className={`${TAB_LABEL_WIDTH_CLASSES} mr-1`}>{tabLabel}</span>
      {showAudioControl && (
        // Why: unlike close, stays visible on inactive tabs; finding the playing tab is the point.
        <button
          type="button"
          aria-label={toggleAudioMutedLabel}
          className="flex items-center justify-center w-4 h-4 rounded-sm shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            setBrowserTabAudioMuted(tab.id, !audioMuted)
          }}
        >
          {audioMuted ? <VolumeX className="size-3" /> : <Volume2 className="size-3" />}
        </button>
      )}
      {!isPinned && (
        <button
          className={`flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${
            isActive
              ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
              : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted'
          }`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  )

  return (
    <>
      <div
        {...slotProps}
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
      >
        {menuOpen ? (
          tabRoot
        ) : (
          <TabHoverCard
            title={tabLabel}
            icon={<BrowserFavicon faviconUrl={tab.faviconUrl} className="size-4" />}
            programName={
              agentDriving
                ? agentDrivingLabel
                : isBlankBrowserTab(tab)
                  ? translate('tabHoverCard.browser', 'Browser')
                  : formatBrowserTabUrlLabel(redactKagiSessionToken(tab.url))
            }
          >
            {tabRoot}
          </TabHoverCard>
        )}
      </div>

      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none fixed size-px opacity-0"
            style={{ left: menuPoint.x, top: menuPoint.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          className={cn(
            'rounded-[11px] border-border/80 p-1 shadow-[0_16px_36px_rgba(0,0,0,0.24)]',
            TAB_CONTEXT_MENU_CONTENT_CLASS
          )}
          sideOffset={0}
          align="start"
        >
          <TabWorkspaceLayoutMenuSection
            unifiedTabId={dragData.unifiedTabId}
            groupId={dragData.groupId}
            trailingSeparator
          />
          {onDuplicate ? (
            <>
              <DropdownMenuItem onSelect={onDuplicate}>
                <Copy className="size-3.5" />
                {translate('auto.components.tab.bar.BrowserTab.5d6e89891f', 'Duplicate Tab')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem onSelect={onTogglePin}>
            {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
            {isPinned
              ? translate('auto.components.tab.bar.BrowserTab.c5aaee8c39', 'Unpin Tab')
              : translate('auto.components.tab.bar.BrowserTab.911542656f', 'Pin Tab')}
          </DropdownMenuItem>
          {showAudioControl ? (
            <DropdownMenuItem onSelect={() => setBrowserTabAudioMuted(tab.id, !audioMuted)}>
              {audioMuted ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
              {toggleAudioMutedLabel}
            </DropdownMenuItem>
          ) : null}
          <CopyTabIdMenuItem unifiedTabId={dragData.unifiedTabId} />
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => !isPinned && onClose()} disabled={isPinned}>
            <X className="size-3.5" />
            {translate('auto.components.tab.bar.BrowserTab.1611a1324b', 'Close')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCloseOthers} disabled={tabCount <= 1}>
            <CopyX className="size-3.5" />
            {translate('components.tab.bar.BrowserTab.closeOthers', 'Close Others')}
          </DropdownMenuItem>
          <CloseSplitPaneMenuItem onCloseSplitPane={onCloseSplitPane} />
          <DropdownMenuItem
            onSelect={() => void window.api.shell.openUrl(openInBrowserUrl)}
            disabled={!isHttpUrl}
          >
            <ExternalLink className="size-3.5" />
            {translate('auto.components.tab.bar.BrowserTab.6e0bc8f3a8', 'Open In Browser')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
