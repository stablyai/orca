import { useCallback, useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { X, Minimize2, Pin } from 'lucide-react'
import { ShellIcon } from './shell-icons'
import { AgentIcon } from '@/lib/agent-catalog'
import { stripLeadingAgentTitleDecoration } from '../../../../shared/agent-title-decoration'
import { useTabAgent } from '@/lib/use-tab-agent'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import type { TerminalTab } from '../../../../shared/types'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import { FilledBellIcon } from '../sidebar/WorktreeCardHelpers'
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
  /** True when this tab is an agent terminal that can switch to the native chat
   *  view. Surfaces the "Switch view" item in the tab context menu. */
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
  // Why: subscribe to the per-tab boolean directly so only the tab whose unread
  // status actually flipped re-renders. Reading the whole `unreadTerminalTabs`
  // map in TabBar would invalidate every SortableTab on every bell event
  // because the slice returns a fresh object reference on each mark/clear.
  const hasUnreadActivity = useAppStore((s) => s.unreadTerminalTabs[tab.id] === true)
  const renamingTabId = useAppStore((s) => s.renamingTabId)
  const setRenamingTabId = useAppStore((s) => s.setRenamingTabId)

  // Why: createTab stamps the shell used at creation time, so changing the
  // default shell later does not repaint existing tabs as a different shell.
  // Older persisted tabs without this field fall back to the generic icon.
  const shellForIcon = tab.shellOverride

  // Why: foreground process and hook status make the tab icon reflect the
  // coding harness currently running in the pane, not just the launch command.
  const tabAgent = useTabAgent(tab)

  // Why: when a provider icon is already shown, stripping the agent's own
  // leading status glyph keeps the tab from presenting two icons for one agent.
  const displayTitle =
    tab.customTitle ?? (tabAgent ? stripLeadingAgentTitleDecoration(tab.title) : tab.title)

  const { attributes, listeners, setNodeRef } = useSortable({
    id: tab.id,
    // Why: carry the resolved agent into the drag overlay so dragged tabs keep
    // the same provider glyph as the tab strip without another store lookup.
    data: { ...dragData, agent: tabAgent }
  })

  // Why: intentionally no transform/transition/opacity here. The PR's
  // design is that tabs stay visually anchored during a drag — only the
  // blue insertion bar moves. Siblings also don't shift (see
  // SortableContext in TabBar.tsx, which omits a strategy for that reason).
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [isEditing, setIsEditing] = useState(false)
  // Why: single source of truth for the unread-activity visual treatment —
  // drives BOTH the amber wash overlay and the bell icon swap below. Kept as
  // one derived boolean so the two visual cues can never drift out of sync
  // (e.g. showing the bell without the wash, or vice versa).
  const showActivityAffordance = hasUnreadActivity && !isEditing
  const [renameValue, setRenameValue] = useState('')
  const renameFocusFrameRef = useRef<number | null>(null)
  // Why: React's synthetic onBlur fires during the Input's unmount when isEditing flips
  // to false. Without this guard, pressing Escape (or committing via Enter) would cause
  // the blur handler to run commitRename a second time and overwrite the title with the
  // uncommitted edits the user just discarded. This ref lets cancelRename/commitRename
  // mark the rename as already resolved so the unmount-driven blur is a no-op.
  const committedOrCancelledRef = useRef(false)

  const handleRenameOpen = useCallback(() => {
    committedOrCancelledRef.current = false
    // Why: snapshot the current title once on open. If the underlying tab.title
    // changes mid-edit (e.g., a shell writes a new title via OSC escape), we
    // intentionally do NOT refresh renameValue — the user's in-progress edit
    // takes precedence so their keystrokes are never silently overwritten.
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
    // Why: defer past Radix menu teardown/focus restore while still keying off
    // input mount only; terminal title updates must not re-select in-progress text.
    renameFocusFrameRef.current = requestAnimationFrame(() => {
      renameFocusFrameRef.current = null
      input.focus()
      input.select()
    })
  }, [])

  // Why: the tab.rename shortcut can't reach this component's local editing
  // state directly, so it sets renamingTabId in the store; the matching tab
  // opens its editor and immediately clears the flag so it fires once.
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

  // Why: Electron <webview> elements run in a separate process, so clicking
  // inside one never dispatches a pointerdown on the renderer document. Radix
  // DropdownMenu relies on document pointerdown for outside-click detection,
  // so it misses webview clicks. Listening for window blur catches the moment
  // focus leaves the renderer (including into a webview).
  useEffect(() => {
    if (!menuOpen) {
      return
    }
    const dismiss = (): void => setMenuOpen(false)
    window.addEventListener('blur', dismiss)
    return () => window.removeEventListener('blur', dismiss)
  }, [menuOpen])

  // Why: while editing, suppress dnd-kit drag listeners and tab-activation/double-click
  // handlers so typing/clicking inside the inline input doesn't start a drag, re-open the
  // editor, or steal focus away from the input. We still spread `attributes` unconditionally
  // so dnd-kit's a11y attributes (aria-roledescription, etc.) remain on the element — only
  // the pointer listeners are gated so a drag can't start while typing.
  const dragListeners = isEditing ? undefined : listeners
  const closeShortcut = useShortcutKeyDetails('tab.close')
  const tabTitle = tab.customTitle ?? tab.title
  const tabRoot = (
    <div
      ref={setNodeRef}
      data-testid="sortable-tab"
      data-tab-id={tab.id}
      data-tab-title={tabTitle}
      data-pinned={isPinned ? 'true' : 'false'}
      // Why: expose the active/inactive flag as a DOM attribute so E2E specs
      // can assert on user-observable selection state without reading the
      // Zustand store. A store-only "is this tab active?" round-trip would
      // pass even if the tab-bar render path had silently broken (the same
      // tautology that let PR #1186's render crash ship past E2E in #1193).
      data-active={isActive ? 'true' : 'false'}
      {...attributes}
      {...dragListeners}
      // Why: on unread activity, tint the whole tab with a subtle amber
      // wash so the signal is visible at a glance even when the small
      // bell icon is easy to miss in a long tab bar. Active tabs keep
      // their existing highlight — the amber wash layers on top so the
      // tab still reads as "selected + has activity". The wash is
      // rendered as an absolutely-positioned child below so the ::after
      // pseudo-element stays free for the drop indicator.
      className={`group relative flex items-center h-full px-1.5 text-xs cursor-pointer select-none outline-none focus:outline-none focus-visible:outline-none ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: includeTopTabBorder })} ${getDropIndicatorClasses(dropIndicator ?? null)} ${getTabRootStateClasses(isActive)}`}
      onDoubleClick={(e) => {
        if (isEditing) {
          return
        }
        e.stopPropagation()
        handleRenameOpen()
      }}
      onPointerDown={(e) => {
        if (isEditing || e.button !== 0) {
          return
        }
        onActivate(tab.id)
        dragListeners?.onPointerDown?.(e)
      }}
      onMouseDown={(e) => {
        // Why: prevent default browser middle-click behavior (auto-scroll)
        // but do NOT close here — closing removes the element before mouseup,
        // causing the mouseup to fall through to the terminal and trigger
        // an X11 primary selection paste on Linux.
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
      {showActivityAffordance && (
        // Why: amber wash for unread tabs. Rendered as a real DOM child so
        // both drop indicators (::before left / ::after right in
        // drop-indicator.ts) stay free for drag-and-drop feedback — a prior
        // ::after-based implementation collided with the right-edge drop
        // indicator and hid it on unread tabs. pointer-events-none keeps
        // clicks reaching the underlying tab handlers.
        <span aria-hidden className="pointer-events-none absolute inset-0 bg-amber-500/10" />
      )}
      {showActivityAffordance ? (
        // Why: the activity marker sits to the LEFT of the tab title using
        // Orca's filled bell glyph (amber-500 with a subtle drop shadow)
        // so it matches the worktree-level bell in the sidebar — keeping
        // every "needs your attention" surface in Orca consistent.
        <span data-testid="tab-activity-bell" className="inline-flex shrink-0">
          <FilledBellIcon className="w-3 h-3 mr-1 text-amber-500 drop-shadow-sm" />
        </span>
      ) : tabAgent ? (
        // Why: coding-agent tabs should read as Claude/Codex/etc. while the
        // harness is running; plain shells keep the generic terminal tile.
        <span
          className={`mr-1 inline-flex shrink-0 ${isActive ? '' : 'opacity-70'}`}
          data-agent-icon={tabAgent}
          aria-hidden
        >
          <AgentIcon agent={tabAgent} size={12} />
        </span>
      ) : (
        // Why: ShellIcon renders a colored brand-style tile for PowerShell,
        // CMD, Git Bash, and WSL so Windows users can distinguish shells at a glance.
        // On mac/linux (or Windows tabs without a resolved shell) it falls
        // back to a matching colored generic-terminal tile — keeping every
        // tab's leading glyph in the same visual idiom instead of mixing a
        // flat lucide chevron with the brand tiles. Opacity dims the icon
        // on inactive tabs to match the existing text treatment without
        // desaturating the brand colors beyond recognition.
        <span
          className={`mr-1 inline-flex shrink-0 ${isActive ? '' : 'opacity-70'}`}
          data-shell-icon={shellForIcon ?? 'generic'}
          aria-hidden
        >
          <ShellIcon shell={shellForIcon} size={12} />
        </span>
      )}
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
            // Why: an Enter that only confirms a CJK IME candidate must not
            // commit the rename; wait for a non-composition Enter.
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
          // Why: stop pointer/mouse events from bubbling to the outer div, which
          // would otherwise trigger tab activation or start a dnd-kit drag while
          // the user is trying to click inside the input.
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => {
            // Why: stop propagation so the outer tab's activation/drag handlers
            // don't fire on clicks inside the input. Also preventDefault on middle
            // click (button 1) to block Linux X11 primary-selection paste into the
            // rename field, matching the outer tab's behavior.
            event.stopPropagation()
            if (event.button === 1) {
              event.preventDefault()
            }
          }}
          onClick={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onAuxClick={(event) => event.stopPropagation()}
          // Why: the base Input applies w-full min-w-0, which lets flex
          // shrink it to ~0 when many tabs compete for horizontal space.
          // Force a minimum width that matches the normal title box so the
          // rename input stays usable even when the tab bar is saturated.
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
              // Why: per-tab close affordance needs a stable accessible name so
              // E2E specs can drive the same path a user takes (hover, then X)
              // instead of bypassing the render layer by calling closeTab() on
              // the store. A store-only assertion would miss an unmounted button.
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
