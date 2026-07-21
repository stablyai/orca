import { useCallback, useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { X, Minimize2, Pin } from 'lucide-react'
import { stripLeadingAgentTitleDecoration } from '../../../../shared/agent-title-decoration'
import { useTabAgent } from '@/lib/use-tab-agent'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import type { TerminalTab } from '../../../../shared/types'
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
import { SortableTabContextMenu } from './SortableTabContextMenu'
import { translate } from '@/i18n/i18n'
import { TAB_CONTAINER_WIDTH_CLASSES, TAB_LABEL_WIDTH_CLASSES } from './tab-width-rules'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { useTabStripPointerActivation } from './tab-strip-pointer-activation'
import { TerminalTabLeadingIcon } from './TerminalTabLeadingIcon'
import {
  hasUnreadAgentCompletionForTerminalTab,
  isTerminalTabActivityLive,
  resolveTerminalTabActivityStatus
} from './terminal-tab-activity-status'

type SortableTabProps = {
  tab: TerminalTab
  unifiedTabId: string
  groupId: string
  tabCount: number
  hasTabsToRight: boolean
  isActive: boolean
  isPinned: boolean
  isExpanded: boolean
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePin: () => void
  onToggleExpand: (tabId: string) => void
  dragData: TabDragItemData
  dropIndicator?: DropIndicator
  includeTopTabBorder?: boolean
  /** True when this agent terminal can switch to native chat view; surfaces the "Switch view" context-menu item. */
  canToggleViewMode?: boolean
  /** True when the tab is currently showing the native chat view. */
  isChatView?: boolean
  /** Toggle the tab between terminal and native chat view. */
  onToggleViewMode?: () => void
}

export const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

export default function SortableTab({
  tab,
  unifiedTabId,
  groupId,
  tabCount,
  hasTabsToRight,
  isActive,
  isPinned,
  isExpanded,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onSetCustomTitle,
  onSetTabColor,
  onTogglePin,
  onToggleExpand,
  dragData,
  dropIndicator,
  includeTopTabBorder = true,
  canToggleViewMode = false,
  isChatView = false,
  onToggleViewMode
}: SortableTabProps): React.JSX.Element {
  // Why: agent-completion unread exists even with terminal-attention off; collapse both sources to one primitive so unrelated tabs don't re-render.
  const hasUnreadActivity = useAppStore(
    (s) =>
      s.unreadTerminalTabs[tab.id] === true ||
      hasUnreadAgentCompletionForTerminalTab(s.unreadAgentCompletionPanes, tab.id)
  )
  // Why: resolver returns a primitive so unrelated agent updates can't repaint this tab (pane bucketing memoized per snapshot).
  const activityStatus = useAppStore((s) =>
    resolveTerminalTabActivityStatus({
      tab,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      agentStatusEpoch: s.agentStatusEpoch,
      runtimePaneTitlesByTabId: s.runtimePaneTitlesByTabId,
      ptyIdsByTabId: s.ptyIdsByTabId,
      terminalLayout: s.terminalLayoutsByTabId?.[tab.id]
    })
  )
  const renamingTabId = useAppStore((s) => s.renamingTabId)
  const setRenamingTabId = useAppStore((s) => s.setRenamingTabId)

  // Why: shellOverride is stamped at create time, so changing the default shell later won't repaint existing tabs.
  const shellForIcon = tab.shellOverride

  // Why: use hook status + title evidence so the icon reflects the harness running now, not just the launch command.
  const tabAgent = useTabAgent(tab)

  // Why: with a provider icon shown, strip the agent's own leading glyph so the tab doesn't show two icons for one agent.
  const displayTitle =
    tab.customTitle ?? (tabAgent ? stripLeadingAgentTitleDecoration(tab.title) : tab.title)

  const { attributes, listeners, setNodeRef } = useSortable({
    id: tab.id,
    // Why: carry the resolved agent into the drag overlay so dragged tabs keep the same glyph without another store lookup.
    data: { ...dragData, agent: tabAgent }
  })

  // Why: no transform/transition/opacity so tabs stay anchored during drag, only the insertion bar moves (see TabBar.tsx).
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [isEditing, setIsEditing] = useState(false)
  // Why: a live working/needs-input state is newer than a prior-turn unread, so it owns the icon until the turn ends.
  const showUnreadActivity =
    hasUnreadActivity && !isEditing && !isTerminalTabActivityLive(activityStatus)
  const [renameValue, setRenameValue] = useState('')
  const renameFocusFrameRef = useRef<number | null>(null)
  // Why: onBlur fires during Input unmount; mark rename resolved so it can't re-commit and overwrite discarded edits.
  const committedOrCancelledRef = useRef(false)

  const handleRenameOpen = useCallback(() => {
    committedOrCancelledRef.current = false
    // Why: snapshot title once; don't refresh if tab.title changes mid-edit (e.g. OSC) so the user's edits aren't overwritten.
    setRenameValue(tab.customTitle ?? tab.title)
    setIsEditing(true)
  }, [tab.customTitle, tab.title])

  const commitRename = useCallback(() => {
    if (committedOrCancelledRef.current) {
      return
    }
    committedOrCancelledRef.current = true
    const trimmed = renameValue.trim()
    onSetCustomTitle(tab.id, trimmed.length > 0 ? trimmed : null)
    setIsEditing(false)
  }, [renameValue, onSetCustomTitle, tab.id])

  const cancelRename = useCallback(() => {
    committedOrCancelledRef.current = true
    setIsEditing(false)
  }, [])

  const setRenameInputElement = useCallback((input: HTMLInputElement | null) => {
    if (renameFocusFrameRef.current !== null) {
      cancelAnimationFrame(renameFocusFrameRef.current)
      renameFocusFrameRef.current = null
    }
    if (!input) {
      return
    }
    // Why: defer past Radix menu teardown/focus restore; key off input mount so title updates don't re-select edited text.
    renameFocusFrameRef.current = requestAnimationFrame(() => {
      renameFocusFrameRef.current = null
      input.focus()
      input.select()
    })
  }, [])

  // Why: the tab.rename shortcut routes through store renamingTabId; open the editor and clear it so it fires once.
  useEffect(() => {
    if (renamingTabId !== tab.id) {
      return
    }
    handleRenameOpen()
    setRenamingTabId(null)
  }, [renamingTabId, tab.id, handleRenameOpen, setRenamingTabId])

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  // Why: webview clicks miss the renderer pointerdown Radix uses for outside-click, so dismiss on window blur instead.
  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const dismiss = (): void => setMenuOpen(false)
    window.addEventListener('blur', dismiss)
    return () => window.removeEventListener('blur', dismiss)
  }, [menuOpen])

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
  const closeShortcut = useShortcutKeyDetails('tab.close')
  const tabTitle = tab.customTitle ?? tab.title
  const tabRoot = (
    <div
      ref={setNodeRef}
      data-testid="sortable-tab"
      data-tab-id={tab.id}
      data-tab-title={tabTitle}
      data-pinned={isPinned ? 'true' : 'false'}
      // Why: DOM attribute lets E2E assert real selection state; a store-only check would miss render breaks (PR #1186 shipped in #1193).
      data-active={isActive ? 'true' : 'false'}
      data-agent-activity-status={activityStatus}
      {...attributes}
      {...dragListeners}
      // Why: subtle amber wash flags unread activity at a glance, layered over the active highlight so it still reads selected.
      className={`group relative flex items-center h-full px-1.5 text-xs cursor-pointer select-none outline-none focus:outline-none focus-visible:outline-none ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: includeTopTabBorder })} ${getDropIndicatorClasses(dropIndicator ?? null)} ${getTabRootStateClasses(isActive)}`}
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
          onKeyDown={(event) => {
            // Why: an Enter confirming a CJK IME candidate must not commit the rename; wait for a non-composition Enter.
            if (isImeCompositionKeyDown(event)) {
              return
            }
            if (event.key === 'Enter') {
              event.preventDefault()
              commitRename()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              cancelRename()
            }
          }}
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
      ) : isEditing || menuOpen ? (
        <span className={`${TAB_LABEL_WIDTH_CLASSES} mr-1`}>{displayTitle}</span>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className={`${TAB_LABEL_WIDTH_CLASSES} mr-1`}>{displayTitle}</span>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            sideOffset={6}
            className="max-w-80 whitespace-normal break-words text-left"
          >
            {displayTitle}
          </TooltipContent>
        </Tooltip>
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
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              className={`relative z-10 flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${
                isActive
                  ? 'text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:text-foreground focus-visible:bg-muted'
                  : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted focus-visible:!text-foreground focus-visible:!bg-muted'
              }`}
              // Why: stable accessible name lets E2E drive the real close path (hover, then X) instead of calling the store.
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
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6} className="flex items-center gap-2">
            <span>{translate('auto.components.tab.bar.SortableTab.95db5f2f7d', 'Close tab')}</span>
            {closeShortcut.keys.length > 0 && (
              <ShortcutKeyCombo keys={closeShortcut.keys} doubleTap={closeShortcut.doubleTap} />
            )}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )

  return (
    <>
      <div
        className={TAB_CONTAINER_WIDTH_CLASSES}
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
      >
        {tabRoot}
      </div>

      <SortableTabContextMenu
        tab={tab}
        unifiedTabId={unifiedTabId}
        groupId={groupId}
        isActive={isActive}
        open={menuOpen}
        point={menuPoint}
        tabCount={tabCount}
        hasTabsToRight={hasTabsToRight}
        isPinned={isPinned}
        onOpenChange={setMenuOpen}
        onActivate={onActivate}
        onClose={onClose}
        onCloseOthers={onCloseOthers}
        onCloseToRight={onCloseToRight}
        onRenameOpen={handleRenameOpen}
        onSetTabColor={onSetTabColor}
        onTogglePin={onTogglePin}
        canToggleViewMode={canToggleViewMode}
        isChatView={isChatView}
        onToggleViewMode={onToggleViewMode}
      />
    </>
  )
}
