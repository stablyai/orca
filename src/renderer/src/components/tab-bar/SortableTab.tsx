import { useCallback, useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { X, Terminal as TerminalIcon, Minimize2, Columns2, Rows2 } from 'lucide-react'
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
  dragData
}: SortableTabProps): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.id,
    data: dragData
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : 1
  }
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [isEditing, setIsEditing] = useState(false)
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
          style={style}
          data-testid="sortable-tab"
          data-tab-title={tab.customTitle ?? tab.title}
          {...attributes}
          {...dragListeners}
          className={`group relative flex items-center h-full px-3 text-sm cursor-pointer select-none shrink-0 border-r border-border ${
            isActive
              ? 'bg-accent text-foreground border-b-transparent'
              : 'bg-card text-muted-foreground hover:text-foreground hover:bg-accent/50'
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
          <TerminalIcon
            className={`w-3.5 h-3.5 mr-1.5 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
          />
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
              className="h-5 w-[130px] min-w-[130px] max-w-[130px] mr-1.5 px-1 py-0 text-xs"
              spellCheck={false}
            />
          ) : (
            <span className="truncate max-w-[130px] mr-1.5">{tab.customTitle ?? tab.title}</span>
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
