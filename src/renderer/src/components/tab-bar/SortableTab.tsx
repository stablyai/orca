import { useCallback, useEffect, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { X, Minimize2, Pin } from 'lucide-react'
import { stripLeadingAgentTitleDecoration } from '../../../../shared/agent-title-decoration'
import { getAgentLabel } from '@/lib/agent-catalog'
import { basename } from '@/lib/path'
import { Input } from '@/components/ui/input'
import { TabHoverCard } from './TabHoverCard'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { TerminalAgent } from '../../../../shared/terminal-agent'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import { useAppStore } from '../../store'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getDropIndicatorClasses,
  getTabRootStateClasses,
  getTabStripBorderClasses,
  type DropIndicator
} from './drop-indicator'
import { preventMiddleButtonDefault } from './middle-button-default-guard'
import { useSortableTabRename } from './use-sortable-tab-rename'
import { useTabRenameReturnFocus } from './use-tab-rename-return-focus'
import { SortableTabContextMenu } from './SortableTabContextMenu'
import { useSortableTabContextMenu } from './use-sortable-tab-context-menu'
import { translate } from '@/i18n/i18n'
import { TAB_LABEL_WIDTH_CLASSES, TAB_ROOT_WIDTH_CLASSES } from './tab-width-rules'
import { useTabStripSlotProps } from './use-tab-strip-slot-props'
import { useTabStripPointerActivation } from './tab-strip-pointer-activation'
import { TerminalTabLeadingIcon } from './TerminalTabLeadingIcon'
import {
  isTerminalTabActivityLive,
  terminalTabHasUnreadActivity
} from './terminal-tab-activity-status'
import { useTerminalTabActivity } from './use-terminal-tab-activity'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/close-all-context-menus'
import type { NativeChatTabSession } from './tab-session-history-switch'
import type { StructuredChatTabNamingFailure } from '@/runtime/structured-conversation-name'
import { useNativeChatNamingFailure } from './use-native-chat-naming-failure'
import { NativeChatNamingErrorBlock, NativeChatNamingFailedDialog } from './NativeChatNamingFailure'

/** What the strip draws for a terminal or native chat tab; never a source of agent identity. */
type SortableTabModel = Pick<
  TerminalTab,
  'id' | 'worktreeId' | 'title' | 'customTitle' | 'color' | 'shellOverride' | 'launchAgent'
>

export type SortableTabProps = {
  tab: SortableTabModel
  /** The tab's agent, resolved by the caller from its own source of truth (pane signals or the chat's provider). */
  agent: TerminalAgent | null
  unifiedTabId: string
  groupId: string
  tabCount: number
  hasTabsToRight: boolean
  hasTabsToLeft: boolean
  isActive: boolean
  isPinned: boolean
  isExpanded: boolean
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onCloseToLeft: (tabId: string) => void
  onCloseSplitPane?: () => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePin: () => void
  onToggleExpand: (tabId: string) => void
  dragData: TabDragItemData
  dropIndicator?: DropIndicator
  includeTopTabBorder?: boolean
  /** True when this agent terminal can switch between the terminal and native chat views; surfaces the "Switch view" context-menu item. */
  canToggleViewMode?: boolean
  isChatView?: boolean
  onToggleViewMode?: () => void
  canSplitTerminal?: boolean
  nativeChat?: NativeChatTabSession
  /** A native chat whose generated name failed, unless the user named the tab. */
  namingFailure?: StructuredChatTabNamingFailure | null
}

export default function SortableTab({
  tab,
  agent: tabAgent,
  unifiedTabId,
  groupId,
  tabCount,
  hasTabsToRight,
  hasTabsToLeft,
  isActive,
  isPinned,
  isExpanded,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onCloseToLeft,
  onCloseSplitPane,
  onSetCustomTitle,
  onSetTabColor,
  onTogglePin,
  onToggleExpand,
  dragData,
  dropIndicator,
  includeTopTabBorder = true,
  canToggleViewMode = false,
  isChatView = false,
  onToggleViewMode,
  canSplitTerminal = true,
  nativeChat,
  namingFailure
}: SortableTabProps): React.JSX.Element {
  const naming = useNativeChatNamingFailure(namingFailure)
  // Why: agent-completion unread exists even with terminal-attention off; collapse both sources to one primitive so unrelated tabs don't re-render.
  const hasUnreadActivity = useAppStore((s) =>
    terminalTabHasUnreadActivity({
      terminalTabId: tab.id,
      unreadTerminalTabs: s.unreadTerminalTabs,
      unreadAgentCompletionPanes: s.unreadAgentCompletionPanes
    })
  )
  const { activityStatus, programProgress } = useTerminalTabActivity(tab)

  // Why: shellOverride is stamped at create time, so changing the default shell later won't repaint existing tabs.
  const shellForIcon = tab.shellOverride

  // Why: with a provider icon shown, strip the agent's own leading glyph so the tab doesn't show two icons for one agent.
  const displayTitle =
    tab.customTitle ?? (tabAgent ? stripLeadingAgentTitleDecoration(tab.title) : tab.title)

  const { attributes, listeners, setNodeRef } = useSortable({
    id: tab.id,
    // Why: carry the resolved agent into the drag overlay so dragged tabs keep the same glyph without another store lookup.
    data: { ...dragData, agent: tabAgent }
  })

  // Why: no transform/transition/opacity so tabs stay anchored during drag, only the insertion bar moves (see TabBar.tsx).
  const {
    open: menuOpen,
    openingId,
    onOpenChange: setMenuOpen,
    onComplete
  } = useSortableTabContextMenu()
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const {
    isEditing,
    renameValue,
    setRenameValue,
    handleRenameOpen,
    commitRename,
    cancelRename,
    setRenameInputElement
  } = useSortableTabRename({
    tabId: tab.id,
    title: tab.title,
    customTitle: tab.customTitle,
    onSetCustomTitle
  })
  const { renameOwnerRef, onRenameKeyDown } = useTabRenameReturnFocus({
    commitRename,
    cancelRename,
    tabId: tab.id,
    unifiedTabId,
    worktreeId: tab.worktreeId,
    groupId,
    isNativeChat: nativeChat !== undefined
  })
  // Why: a live working/needs-input state is newer than a prior-turn unread, so it owns the icon until the turn ends.
  const showUnreadActivity =
    hasUnreadActivity && !isEditing && !isTerminalTabActivityLive(activityStatus)

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [setMenuOpen])

  // Why: webview clicks miss the renderer pointerdown Radix uses for outside-click, so dismiss on window blur instead.
  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const dismiss = (): void => setMenuOpen(false)
    window.addEventListener('blur', dismiss)
    return () => window.removeEventListener('blur', dismiss)
  }, [menuOpen, setMenuOpen])

  // Why: while editing, drop drag listeners so typing can't start a drag; attributes stay spread to keep dnd-kit a11y.
  const dragListeners = isEditing ? undefined : listeners
  const handleActivate = useCallback(() => {
    onActivate(tab.id)
  }, [onActivate, tab.id])
  // Why: defer activation to pointer-up so a drag doesn't switch tabs or steal focus mid-gesture (tab-strip-pointer-activation).
  const { onPointerDown: onTabPointerDown } = useTabStripPointerActivation({
    onActivate: handleActivate,
    disabled: isEditing
  })
  const slotProps = useTabStripSlotProps(tab.id, isActive)
  const tabTitle = tab.customTitle ?? tab.title
  const tabRoot = (
    <div
      ref={setNodeRef}
      data-testid="sortable-tab"
      data-tab-id={tab.id}
      data-tab-title={tabTitle}
      data-pinned={isPinned ? 'true' : 'false'}
      // Expose rendered selection so E2E catches visual regressions missed by store-only assertions.
      data-active={isActive ? 'true' : 'false'}
      data-agent-activity-status={activityStatus}
      {...attributes}
      {...dragListeners}
      className={`${TAB_ROOT_WIDTH_CLASSES} group relative flex items-center h-full px-1.5 text-xs cursor-pointer select-none outline-none focus:outline-none focus-visible:outline-none ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: includeTopTabBorder })} ${getDropIndicatorClasses(dropIndicator ?? null)} ${getTabRootStateClasses(isActive)}`}
      onDoubleClick={(e) => {
        if (isEditing) {
          return
        }
        e.stopPropagation()
        handleRenameOpen()
      }}
      onPointerDown={(e) => {
        onTabPointerDown(
          e,
          dragListeners?.onPointerDown as ((event: React.PointerEvent<Element>) => void) | undefined
        )
      }}
      onMouseDown={(e) => {
        // Why: block middle-click auto-scroll; don't close here — removing the element pre-mouseup triggers a Linux X11 paste.
        if (e.button === 1) {
          e.preventDefault()
        }
      }}
      onMouseUp={preventMiddleButtonDefault}
      onAuxClick={(e) => {
        if (isEditing) {
          return
        }
        if (e.button === 1) {
          e.preventDefault()
          e.stopPropagation()
          if (isPinned) {
            return
          }
          onClose(tab.id)
        }
      }}
    >
      {isActive && <span className={ACTIVE_TAB_INDICATOR_CLASSES} aria-hidden />}
      {showUnreadActivity && (
        // Why: a real DOM child keeps both drop-indicator pseudo-elements free and pointer events reaching the tab.
        <span aria-hidden className="pointer-events-none absolute inset-0 bg-amber-500/10" />
      )}
      <TerminalTabLeadingIcon
        agent={tabAgent}
        activityStatus={activityStatus}
        shell={shellForIcon}
        showUnreadActivity={showUnreadActivity}
        isActive={isActive}
        progress={programProgress}
      />
      {isPinned && !isEditing && (
        <Pin className="mr-1 size-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
      {isEditing ? (
        <Input
          ref={setRenameInputElement}
          data-tab-rename-input="true"
          value={renameValue}
          aria-label={translate(
            'auto.components.tab.bar.SortableTab.ab19f603eb',
            'Rename tab {{value0}}',
            { value0: tabTitle }
          )}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={commitRename}
          onKeyDown={onRenameKeyDown}
          // Why: stop bubbling so clicking inside the input doesn't activate the tab or start a dnd-kit drag.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            // Why: stopPropagation avoids outer tab activation/drag; preventDefault on middle-click blocks Linux X11 paste.
            event.stopPropagation()
            if (event.button === 1) {
              event.preventDefault()
            }
          }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onAuxClick={(event) => event.stopPropagation()}
          // Why: base Input's min-w-0 lets flex shrink it to ~0 in a saturated tab bar; force a usable minimum width.
          className="mr-1 h-5 min-w-[72px] flex-1 px-1 py-0 text-xs"
          spellCheck={false}
        />
      ) : (
        <span className={`${TAB_LABEL_WIDTH_CLASSES} mr-1`}>{displayTitle}</span>
      )}
      {tab.color && !isEditing && (
        <span
          className="mr-1.5 size-2 rounded-full shrink-0"
          style={{ backgroundColor: tab.color }}
        />
      )}
      {isExpanded && !isEditing && (
        <button
          className={`mr-1 flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${
            isActive
              ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
              : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted'
          }`}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand(tab.id)
          }}
          title={translate('auto.components.tab.bar.SortableTab.fdb2691425', 'Collapse pane')}
          aria-label={translate('auto.components.tab.bar.SortableTab.fdb2691425', 'Collapse pane')}
        >
          <Minimize2 className="w-3 h-3" />
        </button>
      )}
      {!isEditing && !isPinned && (
        <button
          className={`relative z-10 flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${
            isActive
              ? 'text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:text-foreground focus-visible:bg-muted'
              : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted focus-visible:!text-foreground focus-visible:!bg-muted'
          }`}
          // Why: stable accessible name lets E2E drive the real close path instead of calling the store.
          aria-label={translate(
            'auto.components.tab.bar.SortableTab.6df69d9388',
            'Close tab {{value0}}',
            { value0: tabTitle }
          )}
          type="button"
          data-tab-close-button="true"
          onPointerDown={(e) => {
            if (e.button === 0) {
              e.stopPropagation()
            }
          }}
          onMouseDown={(e) => {
            if (e.button === 0) {
              e.stopPropagation()
            }
          }}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            onClose(tab.id)
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
        ref={renameOwnerRef}
        {...slotProps}
        onContextMenuCapture={(event) => {
          // The hover card is portalled: React still routes its events through this slot.
          if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
            event.preventDefault()
            window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
            setMenuPoint({ x: event.clientX, y: event.clientY })
            setMenuOpen(true)
          }
        }}
      >
        {isEditing || menuOpen ? (
          tabRoot
        ) : (
          <TabHoverCard
            title={displayTitle}
            programName={
              tabAgent
                ? getAgentLabel(tabAgent)
                : shellForIcon
                  ? basename(shellForIcon)
                  : translate('tabHoverCard.terminal', 'Terminal')
            }
            icon={
              <TerminalTabLeadingIcon
                agent={tabAgent}
                activityStatus={activityStatus}
                shell={shellForIcon}
                showUnreadActivity={false}
                isActive
                progress={programProgress}
              />
            }
            alert={naming ? <NativeChatNamingErrorBlock naming={naming} /> : undefined}
          >
            {tabRoot}
          </TabHoverCard>
        )}
      </div>

      <SortableTabContextMenu
        sessionSwitchOpening={openingId}
        onSessionSwitchComplete={onComplete}
        tab={tab}
        unifiedTabId={unifiedTabId}
        groupId={groupId}
        isActive={isActive}
        open={menuOpen}
        point={menuPoint}
        tabCount={tabCount}
        hasTabsToRight={hasTabsToRight}
        hasTabsToLeft={hasTabsToLeft}
        isPinned={isPinned}
        onOpenChange={setMenuOpen}
        onActivate={onActivate}
        onClose={onClose}
        onCloseOthers={onCloseOthers}
        onCloseToRight={onCloseToRight}
        onCloseToLeft={onCloseToLeft}
        onCloseSplitPane={onCloseSplitPane}
        onRenameOpen={handleRenameOpen}
        onSetTabColor={onSetTabColor}
        onTogglePin={onTogglePin}
        canToggleViewMode={canToggleViewMode}
        isChatView={isChatView}
        onToggleViewMode={onToggleViewMode}
        canSplitTerminal={canSplitTerminal}
        nativeChat={nativeChat}
      />
      {naming ? <NativeChatNamingFailedDialog naming={naming} chatName={displayTitle} /> : null}
    </>
  )
}
