import React, { useEffect, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { X, Volume2, VolumeX } from 'lucide-react'
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { TabHoverCard } from '../strip/TabHoverCard'
import '../../../../../shared/orca-profiles/constants'
import { redactKagiSessionToken } from '../../../../../shared/browser/navigation/browser-url'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/overlay-interaction/close-all-context-menus'
import type { TabDragItemData } from '../../tab-group/drag/tab-drag-data'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getDropIndicatorClasses,
  getTabRootStateClasses,
  getTabStripBorderClasses,
  type DropIndicator
} from '../strip/drop-indicator'
import { preventMiddleButtonDefault } from '../strip/middle-button-default-guard'
import '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { TAB_LABEL_WIDTH_CLASSES } from '../strip/tab-width-rules'
import { useTabStripSlotProps } from '../strip/use-tab-strip-slot-props'
import { useTabStripPointerActivation } from '../strip/tab-strip-pointer-activation'
import { useTabContextMenuOpening } from '../strip/tab-context-menu-opening'
import { BrowserFavicon } from '@/components/browser-pane/describe-page/browser-favicon'
import { AgentCursorGlyph } from '../../browser-pane/agent-cursor/agent-cursor-glyph'
import {
  useBrowserAgentControllerHost,
  useBrowserAgentDrivesAnyPage
} from '../../browser-pane/agent-cursor/browser-agent-activity-state'
import { useAppStore } from '@/store/index'

const LazyBrowserTabContextMenu = lazyWithRetry(
  () => import('./BrowserTabContextMenu').then((m) => ({ default: m.BrowserTabContextMenu })),
  { reloadKey: 'browser-tab-context-menu' }
)

import { formatBrowserTabUrlLabel, getBrowserTabLabel } from './browser-tab-label'
import { isBlankBrowserUrl } from '@/lib/browser/palette/browser-palette-search'

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
  tab: BrowserWorkspace
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
  const t = useTranslate()
  // Keep dragged tabs anchored; only the insertion bar moves.
  const { attributes, listeners, setNodeRef } = useSortable({
    id: tab.id,
    data: dragData
  })
  const [menuOpen, setMenuOpen] = useState(false)
  const hasOpenedMenu = useLatchedOpen(menuOpen)

  const tabLabel = getBrowserTabLabel(tab, t)
  const audible = useAppStore((s) =>
    (s.browserPagesByWorkspace[tab.id] ?? []).some((page) => s.browserAudiblePageIds[page.id])
  )
  const audioMuted = useAppStore((s) => Boolean(s.browserAudioMutedTabIds[tab.id]))
  // Why: a muted tab keeps its icon after sound stops, so it can be unmuted from the strip.
  const showAudioControl = audible || audioMuted
  const setBrowserTabAudioMuted = useAppStore((s) => s.setBrowserTabAudioMuted)
  const toggleAudioMutedLabel = audioMuted
    ? t('components.tab.bar.BrowserTab.unmuteTab', 'Unmute Tab')
    : t('components.tab.bar.BrowserTab.muteTab', 'Mute Tab')
  const tabPageIds = tab.pageIds ?? [tab.activePageId]
  const agentDriving = useBrowserAgentDrivesAnyPage(tabPageIds)
  const controllerHost = useBrowserAgentControllerHost(tabPageIds)
  const agentDrivingLabel = controllerHost
    ? t('browserTab.controlledByHost', 'Controlled by {{host}}', { host: controllerHost })
    : t('browserTab.agentDriving', 'An agent is using this page')

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
  const { onPointerDown: onTabPointerDown, retirePendingActivation } = useTabStripPointerActivation(
    { onActivate }
  )
  const handleMenuOpenChange = useTabContextMenuOpening(setMenuOpen, retirePendingActivation)
  const slotProps = useTabStripSlotProps(tab.id, isActive)

  const tabRoot = (
    <div
      ref={setNodeRef}
      data-tab-id={tab.id}
      data-active={isActive ? 'true' : 'false'}
      data-pinned={isPinned ? 'true' : 'false'}
      {...attributes}
      {...listeners}
      className={`w-full group relative flex items-center h-full px-1.5 text-xs cursor-pointer select-none outline-none focus:outline-none focus-visible:outline-none ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: includeTopTabBorder })} ${getDropIndicatorClasses(dropIndicator ?? null)} ${getTabRootStateClasses(isActive)}`}
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
          loading={tab.loading && !tab.loadError && !isBlankBrowserUrl(tab.url)}
          className="size-3 mr-1"
          fallbackClassName="text-blue-500"
        />
      )}
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
    <ContextMenu open={menuOpen} onOpenChange={handleMenuOpenChange} modal={false}>
      <ContextMenuTrigger asChild>
        <div
          {...slotProps}
          onContextMenu={() => {
            window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
            handleMenuOpenChange(true)
          }}
        >
          {menuOpen ? (
            tabRoot
          ) : (
            <TabHoverCard
              title={tabLabel}
              showWhenUnclipped={controllerHost !== null}
              icon={<BrowserFavicon faviconUrl={tab.faviconUrl} className="size-4" />}
              programName={
                agentDriving
                  ? agentDrivingLabel
                  : isBlankBrowserUrl(tab.url)
                    ? t('tabHoverCard.browser', 'Browser')
                    : formatBrowserTabUrlLabel(redactKagiSessionToken(tab.url), t)
              }
            >
              {tabRoot}
            </TabHoverCard>
          )}
        </div>
      </ContextMenuTrigger>
      {hasOpenedMenu ? (
        <React.Suspense fallback={null}>
          <LazyBrowserTabContextMenu
            tab={tab}
            unifiedTabId={dragData.unifiedTabId}
            groupId={dragData.groupId}
            isPinned={isPinned}
            tabCount={tabCount}
            showAudioControl={showAudioControl}
            audioMuted={audioMuted}
            toggleAudioMutedLabel={toggleAudioMutedLabel}
            onToggleAudioMuted={() => setBrowserTabAudioMuted(tab.id, !audioMuted)}
            onDuplicate={onDuplicate}
            onTogglePin={onTogglePin}
            onClose={onClose}
            onCloseOthers={onCloseOthers}
            onCloseSplitPane={onCloseSplitPane}
            onOpenExternally={(url) => void window.api.shell.openUrl(url)}
          />
        </React.Suspense>
      ) : null}
    </ContextMenu>
  )
}
