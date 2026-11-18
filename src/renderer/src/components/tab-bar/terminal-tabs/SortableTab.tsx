import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu'
import { useCallback, useEffect } from 'react'
import { Minimize2, Pin } from 'lucide-react'
import { stripLeadingAgentTitleDecoration } from '../../../../../shared/agent-status/title/agent-title-decoration'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import { basename } from '@/lib/path'
import { Input } from '@/components/ui/input'
import { TabHoverCard } from '../strip/TabHoverCard'
import type { SortableTabProps } from './sortable-tab-props'

import { useAppStore } from '../../../store/index'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getDropIndicatorClasses,
  getTabRootStateClasses,
  getTabStripBorderClasses
} from '../strip/drop-indicator'
import { preventMiddleButtonDefault } from '../strip/middle-button-default-guard'
import { useSortableTabRename } from './use-sortable-tab-rename'
import { useTabRenameReturnFocus } from './use-tab-rename-return-focus'
import { SortableTabContextMenu } from './SortableTabContextMenu'
import { SortableTabCloseButton } from './SortableTabCloseButton'
import { useSortableTabContextMenu } from './use-sortable-tab-context-menu'
import { useSortableTabDrag } from './use-sortable-tab-drag'
import { useTranslate } from '@/i18n/use-translate'
import { TAB_LABEL_WIDTH_CLASSES } from '../strip/tab-width-rules'
import { useTabStripSlotProps } from '../strip/use-tab-strip-slot-props'
import { useTabStripPointerActivation } from '../strip/tab-strip-pointer-activation'
import { useTabContextMenuOpening } from '../strip/tab-context-menu-opening'
import { TerminalTabLeadingIcon } from './TerminalTabLeadingIcon'
import {
  isTerminalTabActivityLive,
  terminalTabHasUnreadActivity
} from './terminal-tab-activity-status'
import { useTerminalTabActivity } from './use-terminal-tab-activity'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '@/lib/overlay-interaction/close-all-context-menus'

import { useNativeChatNamingFailure } from '../session-actions/use-native-chat-naming-failure'
import {
  NativeChatNamingErrorBlock,
  NativeChatNamingFailedDialog
} from '../session-actions/NativeChatNamingFailure'
import { ForkMarkedName } from '../../native-chat/fork/ForkMarkedName'

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
  namingFailure,
  closable = true,
  canContinueInTerminal = true,
  identityIcon,
  identityDetail,
  unread = false,
  fork
}: SortableTabProps): React.JSX.Element {
  const t = useTranslate()
  const canClose = closable && !isPinned
  const naming = useNativeChatNamingFailure(namingFailure)
  // Why: agent-completion unread exists even with terminal-attention off; collapse both sources to one primitive so unrelated tabs don't re-render.
  const hasUnreadActivity = useAppStore(
    (s) =>
      unread ||
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

  // Why: carry the resolved agent into the drag overlay so dragged tabs keep the same glyph without another store lookup.
  const { attributes, listeners, setNodeRef } = useSortableTabDrag(tab.id, {
    ...dragData,
    agent: tabAgent
  })

  // Why: no transform/transition/opacity so tabs stay anchored during drag, only the insertion bar moves (see TabBar.tsx).
  const {
    open: menuOpen,
    openingId,
    onOpenChange: setMenuOpen,
    onComplete
  } = useSortableTabContextMenu()
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
    onSetCustomTitle,
    renamable: closable
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
  const { onPointerDown, retirePendingActivation } = useTabStripPointerActivation({
    onActivate: handleActivate,
    disabled: isEditing
  })
  const handleMenuOpenChange = useTabContextMenuOpening(setMenuOpen, retirePendingActivation)
  const slotProps = useTabStripSlotProps(tab.id, isActive, 'terminal')
  const tabTitle = tab.customTitle ?? tab.title
  const titleNode = fork ? <ForkMarkedName name={displayTitle} narrowIcon /> : displayTitle
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
      // The drag handle's describedby owns the description, so the names join the tab's name.
      aria-label={identityDetail ? `${tabTitle}, ${identityDetail}` : undefined}
      {...attributes}
      {...dragListeners}
      className={`${fork ? '@container/tab ' : ''}w-full group relative flex items-center h-full px-1.5 text-xs cursor-pointer select-none outline-none focus:outline-none focus-visible:outline-none ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: includeTopTabBorder })} ${getDropIndicatorClasses(dropIndicator ?? null)} ${getTabRootStateClasses(isActive)}`}
      onDoubleClick={(e) => {
        if (isEditing) {
          return
        }
        e.stopPropagation()
        handleRenameOpen()
      }}
      onPointerDown={(e) => {
        onPointerDown(
          e,
          dragListeners?.onPointerDown as ((event: React.PointerEvent<Element>) => void) | undefined
        )
      }}
      // Why: block middle-click auto-scroll; don't close here — removing the element pre-mouseup triggers a Linux X11 paste.
      onMouseDown={preventMiddleButtonDefault}
      onMouseUp={preventMiddleButtonDefault}
      onAuxClick={(e) => {
        if (isEditing) {
          return
        }
        if (e.button === 1) {
          e.preventDefault()
          e.stopPropagation()
          if (!canClose) {
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
        identity={identityIcon}
      />
      {isPinned && !isEditing && (
        <Pin className="mr-1 size-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
      {isEditing ? (
        <Input
          ref={setRenameInputElement}
          density="compact"
          data-tab-rename-input="true"
          value={renameValue}
          aria-label={t('auto.components.tab.bar.SortableTab.ab19f603eb', 'Rename tab {{value0}}', {
            value0: tabTitle
          })}
          onChange={(event) => setRenameValue(event.target.value)}
          onBlur={commitRename}
          onKeyDown={onRenameKeyDown}
          // Why: stop bubbling so clicking inside the input doesn't activate the tab or start a dnd-kit drag.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            // Why: stopPropagation avoids outer tab activation/drag; preventDefault on middle-click blocks Linux X11 paste.
            event.stopPropagation()
            preventMiddleButtonDefault(event)
          }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onAuxClick={(event) => event.stopPropagation()}
          className="mr-1 min-w-0 flex-1"
          spellCheck={false}
        />
      ) : (
        <span className={`${TAB_LABEL_WIDTH_CLASSES} mr-1`}>{titleNode}</span>
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
          title={t('auto.components.tab.bar.SortableTab.fdb2691425', 'Collapse pane')}
          aria-label={t('auto.components.tab.bar.SortableTab.fdb2691425', 'Collapse pane')}
        >
          <Minimize2 className="w-3 h-3" />
        </button>
      )}
      {!isEditing && canClose && (
        <SortableTabCloseButton
          tabTitle={fork?.markedTitle ?? tabTitle}
          isActive={isActive}
          onClose={() => onClose(tab.id)}
        />
      )}
    </div>
  )

  return (
    <ContextMenu open={menuOpen} onOpenChange={handleMenuOpenChange} modal={false}>
      <ContextMenuTrigger asChild>
        <div
          ref={renameOwnerRef}
          {...slotProps}
          onContextMenu={(event) => {
            // The hover card is portalled: React still routes its events through this slot.
            if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
              window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
              handleMenuOpenChange(true)
            }
          }}
        >
          {isEditing || menuOpen ? (
            tabRoot
          ) : (
            <TabHoverCard
              title={displayTitle}
              showWhenUnclipped={identityDetail !== undefined}
              programNameIsProse={identityDetail !== undefined}
              {...(fork && { description: fork.describeSource, showWhenUnclipped: true })}
              programName={
                identityDetail ??
                (tabAgent
                  ? getAgentLabel(tabAgent)
                  : shellForIcon
                    ? basename(shellForIcon)
                    : t('tabHoverCard.terminal', 'Terminal'))
              }
              icon={
                <TerminalTabLeadingIcon
                  agent={tabAgent}
                  activityStatus={activityStatus}
                  shell={shellForIcon}
                  showUnreadActivity={false}
                  isActive
                  progress={programProgress}
                  identity={identityIcon}
                />
              }
              alert={
                naming
                  ? (dismiss) => <NativeChatNamingErrorBlock naming={naming} onDismiss={dismiss} />
                  : undefined
              }
            >
              {tabRoot}
            </TabHoverCard>
          )}
        </div>
      </ContextMenuTrigger>

      <SortableTabContextMenu
        open={menuOpen}
        sessionSwitchOpening={openingId}
        onSessionSwitchComplete={onComplete}
        tab={tab}
        unifiedTabId={unifiedTabId}
        groupId={groupId}
        isActive={isActive}
        tabCount={tabCount}
        hasTabsToRight={hasTabsToRight}
        hasTabsToLeft={hasTabsToLeft}
        isPinned={isPinned}
        closable={closable}
        canContinueInTerminal={canContinueInTerminal}
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
    </ContextMenu>
  )
}
