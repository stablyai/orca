import { useCallback, useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { X, Minimize2, Columns2, Rows2 } from 'lucide-react'
import { ShellIcon } from './shell-icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type { TerminalTab } from '../../../../shared/types'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'
import { FilledBellIcon } from '../sidebar/WorktreeCardHelpers'
import { useAppStore } from '../../store'
import {
  ACTIVE_TAB_INDICATOR_CLASSES,
  getDropIndicatorClasses,
  type DropIndicator
} from './drop-indicator'

type SortableTabProps = {
  tab: TerminalTab
  tabCount: number
  hasTabsToRight: boolean
  isActive: boolean
  isExpanded: boolean
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onToggleExpand: (tabId: string) => void
  onSplitGroup: (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId: string) => void
  dragData: TabDragItemData
  dropIndicator?: DropIndicator
}

export const TAB_COLORS = [
  { label: 'None', value: null },
  { label: 'Blue', value: '#3b82f6' },
  { label: 'Purple', value: '#a855f7' },
  { label: 'Pink', value: '#ec4899' },
  { label: 'Red', value: '#ef4444' },
  { label: 'Orange', value: '#f97316' },
  { label: 'Yellow', value: '#eab308' },
  { label: 'Green', value: '#22c55e' },
  { label: 'Teal', value: '#14b8a6' },
  { label: 'Gray', value: '#9ca3af' }
]

export const CLOSE_ALL_CONTEXT_MENUS_EVENT = 'orca-close-all-context-menus'

export default function SortableTab({
  tab,
  tabCount,
  hasTabsToRight,
  isActive,
  isExpanded,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseToRight,
  onSetCustomTitle,
  onSetTabColor,
  onToggleExpand,
  onSplitGroup,
  dragData,
  dropIndicator
}: SortableTabProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef } = useSortable({
    id: tab.id,
    data: dragData
  })

  // Why: subscribe to the per-tab boolean directly so only the tab whose unread
  // status actually flipped re-renders. Reading the whole `unreadTerminalTabs`
  // map in TabBar would invalidate every SortableTab on every bell event
  // because the slice returns a fresh object reference on each mark/clear.
  const hasUnreadActivity = useAppStore((s) => s.unreadTerminalTabs[tab.id] === true)

  // Why: on Windows, tabs created before the per-tab shell override landed (or
  // created via the default Ctrl+T path without picking a specific shell)
  // don't carry a shellOverride. We still want the tab-strip icon to reflect
  // the shell actually running, so fall back to the user's configured default
  // Windows shell. On mac/linux this resolves to undefined and the ShellIcon
  // generic-terminal fallback renders.
  const defaultWindowsShell = useAppStore((s) => s.settings?.terminalWindowsShell)
  const isWindows = navigator.userAgent.includes('Windows')
  const shellForIcon = tab.shellOverride ?? (isWindows ? defaultWindowsShell : undefined)

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
  const renameInputRef = useRef<HTMLInputElement>(null)
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

  // Why: rAF defers focus()+select() until after the Input mounts so the text
  // is pre-selected (overwriting the old title is the common case). Deps are
  // intentionally just [isEditing] — we do NOT re-run when tab.title or
  // tab.customTitle change mid-edit, so external title updates cannot
  // re-focus/re-select and disrupt the user's typing.
  useEffect(() => {
    if (!isEditing) {
      return
    }
    const frame = requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [isEditing])

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

  return (
    <>
      <div
        onContextMenuCapture={(event) => {
          event.preventDefault()
          window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
          setMenuPoint({ x: event.clientX, y: event.clientY })
          setMenuOpen(true)
        }}
      >
        <div
          ref={setNodeRef}
          data-testid="sortable-tab"
          data-tab-id={tab.id}
          data-tab-title={tab.customTitle ?? tab.title}
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
          className={`group relative flex items-center h-full px-1.5 text-xs cursor-pointer select-none shrink-0 outline-none focus:outline-none focus-visible:outline-none border-t ${hasTabsToRight ? 'border-r' : ''} border-border bg-card ${getDropIndicatorClasses(dropIndicator ?? null)} ${
            isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
          }`}
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
          onAuxClick={(e) => {
            if (isEditing) {
              return
            }
            if (e.button === 1) {
              e.preventDefault()
              e.stopPropagation()
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
            // Orca's filled bell glyph (amber-500 with a subtle drop shadow).
            // The sidebar WorktreeCard used to render the same bell; it now
            // uses a bold-title treatment. The tab bar keeps the bell for
            // now — aligning the two surfaces is a deliberate follow-up.
            <span data-testid="tab-activity-bell" className="inline-flex shrink-0">
              <FilledBellIcon className="w-3 h-3 mr-1 text-amber-500 drop-shadow-sm" />
            </span>
          ) : (
            // Why: ShellIcon renders a colored brand-style tile for PowerShell,
            // CMD, and WSL so Windows users can distinguish shells at a glance.
            // On mac/linux (or Windows tabs without a resolved shell) it falls
            // back to a matching colored generic-terminal tile — keeping every
            // tab's leading glyph in the same visual idiom instead of mixing a
            // flat lucide chevron with the brand tiles. Opacity dims the icon
            // on inactive tabs to match the existing text treatment without
            // desaturating the brand colors beyond recognition.
            <span
              className={`mr-1 inline-flex shrink-0 ${isActive ? '' : 'opacity-70'}`}
              aria-hidden
            >
              <ShellIcon shell={shellForIcon} size={12} />
            </span>
          )}
          {isEditing ? (
            <Input
              ref={renameInputRef}
              value={renameValue}
              aria-label={`Rename tab ${tab.customTitle ?? tab.title}`}
              onChange={(event) => setRenameValue(event.target.value)}
              onBlur={commitRename}
              onKeyDown={(event) => {
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
              className="h-5 w-[72px] min-w-[72px] max-w-[72px] mr-1 px-1 py-0 text-xs"
              spellCheck={false}
            />
          ) : (
            <span className="truncate max-w-[72px] mr-1">{tab.customTitle ?? tab.title}</span>
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
              title="Collapse pane"
              aria-label="Collapse pane"
            >
              <Minimize2 className="w-3 h-3" />
            </button>
          )}
          {!isEditing && (
            <button
              className={`flex items-center justify-center w-4 h-4 rounded-sm shrink-0 ${
                isActive
                  ? 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  : 'text-transparent group-hover:text-muted-foreground hover:!text-foreground hover:!bg-muted'
              }`}
              // Why: per-tab close affordance needs a stable accessible name so
              // E2E specs can drive the same path a user takes (hover → click X)
              // instead of bypassing the render layer by calling closeTab() on
              // the store — a store-only assertion would pass even if this
              // button had been accidentally unmounted.
              aria-label={`Close tab ${tab.customTitle ?? tab.title}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation()
                onClose(tab.id)
              }}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
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
        <DropdownMenuContent className="w-48" sideOffset={0} align="start">
          <DropdownMenuItem onSelect={() => onSplitGroup('up', tab.id)}>
            <Rows2 className="mr-1.5 size-3.5" />
            Split Up
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('down', tab.id)}>
            <Rows2 className="mr-1.5 size-3.5" />
            Split Down
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('left', tab.id)}>
            <Columns2 className="mr-1.5 size-3.5" />
            Split Left
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('right', tab.id)}>
            <Columns2 className="mr-1.5 size-3.5" />
            Split Right
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onClose(tab.id)}>Close</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onCloseOthers(tab.id)} disabled={tabCount <= 1}>
            Close Others
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onCloseToRight(tab.id)} disabled={!hasTabsToRight}>
            Close Tabs To The Right
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleRenameOpen}>Change Title</DropdownMenuItem>
          <div className="px-2 pt-1.5 pb-1">
            <div className="text-xs font-medium text-muted-foreground mb-1.5">Tab Color</div>
            <div className="flex flex-wrap gap-2">
              {TAB_COLORS.map((color) => {
                const isSelected = tab.color === color.value
                return (
                  <DropdownMenuItem
                    key={color.label}
                    className={`relative h-4 w-4 min-w-4 p-0 rounded-full border ${
                      isSelected
                        ? 'ring-1 ring-foreground/70 ring-offset-1 ring-offset-popover'
                        : ''
                    } ${
                      color.value
                        ? 'border-transparent'
                        : 'border-muted-foreground/50 bg-transparent'
                    }`}
                    style={color.value ? { backgroundColor: color.value } : undefined}
                    onSelect={() => {
                      onSetTabColor(tab.id, color.value)
                    }}
                  >
                    {color.value === null && (
                      <span className="absolute block h-px w-3 rotate-45 bg-muted-foreground/80" />
                    )}
                  </DropdownMenuItem>
                )
              })}
            </div>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
