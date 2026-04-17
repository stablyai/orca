import { useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  X,
  FileCode,
  GitCompareArrows,
  Copy,
  ShieldAlert,
  ExternalLink,
  Columns2,
  Rows2
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { basename, normalizeRelativePath } from '@/lib/path'
import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import { renameFileOnDisk } from '@/lib/rename-file'
import { useAppStore } from '@/store'
import { STATUS_COLORS, STATUS_LABELS } from '../right-sidebar/status-display'
import type { GitFileStatus } from '../../../../shared/types'
import type { OpenFile } from '../../store/slices/editor'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from './SortableTab'
import type { TabDragItemData } from '../tab-group/useTabDragSplit'

const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

/** Platform-appropriate label: macOS → Finder, Windows → File Explorer, Linux → Files */
const revealLabel = isMac
  ? 'Reveal in Finder'
  : isLinux
    ? 'Open Containing Folder'
    : 'Reveal in File Explorer'

export default function EditorFileTab({
  file,
  isActive,
  hasTabsToRight,
  statusByRelativePath,
  onActivate,
  onClose,
  onCloseToRight,
  onCloseAll,
  onPin,
  onSplitGroup,
  dragData
}: {
  file: OpenFile & { tabId?: string }
  isActive: boolean
  hasTabsToRight: boolean
  statusByRelativePath: Map<string, GitFileStatus>
  onActivate: () => void
  onClose: () => void
  onCloseToRight: () => void
  onCloseAll: () => void
  onPin?: () => void
  onSplitGroup: (direction: 'left' | 'right' | 'up' | 'down', sourceVisibleTabId: string) => void
  dragData: TabDragItemData
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    // Why: split groups can duplicate the same open file into multiple visible
    // tabs. Using the unified tab ID keeps each rendered tab draggable as a
    // distinct item instead of collapsing every copy onto the file entity ID.
    id: file.tabId ?? file.id,
    data: dragData
  })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.8 : 1
  }

  const isDiff = file.mode === 'diff'
  const isConflictReview = file.mode === 'conflict-review'
  const [menuOpen, setMenuOpen] = useState(false)
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 })
  const [isRenaming, setIsRenaming] = useState(false)
  const renameInputRef = useRef<HTMLInputElement>(null)
  // Escape fires setIsRenaming(false), which unmounts the input. The browser
  // still fires focusout as the focused node is removed, so onBlur can invoke
  // commitRename *after* cancel — committing the typed value against the
  // user's intent. This flag suppresses the trailing blur-commit.
  const renameCancelledRef = useRef(false)
  // Only real on-disk files in edit mode are renameable. Diff, conflict-review,
  // untitled drafts, and combined/virtual views don't point at a single concrete
  // file we can safely rename.
  const canRename = file.mode === 'edit' && !file.isUntitled && !file.diffSource && !file.conflict

  const commitRename = (): void => {
    if (renameCancelledRef.current) {
      renameCancelledRef.current = false
      setIsRenaming(false)
      return
    }
    const input = renameInputRef.current
    if (!input) {
      setIsRenaming(false)
      return
    }
    const newName = input.value.trim()
    setIsRenaming(false)
    if (!newName) {
      return
    }
    const oldName = basename(file.filePath)
    if (newName === oldName) {
      return
    }
    const worktreePath = (() => {
      const state = useAppStore.getState()
      for (const worktrees of Object.values(state.worktreesByRepo)) {
        const wt = worktrees.find((w) => w.id === file.worktreeId)
        if (wt) {
          return wt.path
        }
      }
      return null
    })()
    if (!worktreePath) {
      return
    }
    void renameFileOnDisk({
      oldPath: file.filePath,
      newName,
      worktreeId: file.worktreeId,
      worktreePath
    })
  }

  useEffect(() => {
    if (!isRenaming) {
      return
    }
    const raf = requestAnimationFrame(() => {
      const el = renameInputRef.current
      if (!el) {
        return
      }
      el.focus()
      const name = basename(file.filePath)
      const dotIndex = name.lastIndexOf('.')
      if (dotIndex > 0) {
        el.setSelectionRange(0, dotIndex)
      } else {
        el.select()
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [isRenaming, file.filePath])

  const tabStatus =
    file.relativePath === 'All Changes'
      ? null
      : (statusByRelativePath.get(normalizeRelativePath(file.relativePath)) ?? null)
  const tabStatusColor = tabStatus ? STATUS_COLORS[tabStatus] : undefined

  useEffect(() => {
    const closeMenu = (): void => setMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

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
          {...attributes}
          {...listeners}
          className={`group relative flex items-center h-full px-3 text-sm cursor-pointer select-none shrink-0 border-r border-border ${
            isActive
              ? 'bg-accent/40 text-foreground border-b-transparent'
              : 'bg-card text-muted-foreground hover:text-foreground hover:bg-accent/50'
          }`}
          onPointerDown={(e) => {
            if (e.button !== 0) {
              return
            }
            onActivate()
            listeners?.onPointerDown?.(e)
          }}
          onDoubleClick={() => {
            if (file.isPreview && onPin) {
              onPin()
            }
          }}
          onMouseDown={(e) => {
            if (e.button === 1) {
              e.preventDefault()
            }
          }}
          onAuxClick={(e) => {
            if (e.button === 1) {
              e.preventDefault()
              e.stopPropagation()
              onClose()
            }
          }}
        >
          {isConflictReview ? (
            <ShieldAlert
              className={`w-3.5 h-3.5 mr-1.5 shrink-0 ${isActive ? 'text-orange-400' : 'text-orange-400/70'}`}
            />
          ) : isDiff ? (
            <GitCompareArrows
              className={`w-3.5 h-3.5 mr-1.5 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
            />
          ) : (
            <FileCode
              className={`w-3.5 h-3.5 mr-1.5 shrink-0 ${isActive ? 'text-foreground' : 'text-muted-foreground'}`}
            />
          )}
          <span className="mr-1.5 flex min-w-0 items-baseline gap-1.5">
            {isRenaming ? (
              <input
                ref={renameInputRef}
                defaultValue={basename(file.filePath)}
                // Tiny border to make the edit affordance obvious without
                // changing overall tab height. Size matches the label span.
                className="truncate max-w-[130px] bg-transparent text-sm text-foreground outline-none border border-ring rounded-sm px-1 py-0"
                onPointerDown={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    e.stopPropagation()
                    commitRename()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    renameCancelledRef.current = true
                    setIsRenaming(false)
                  }
                }}
                onBlur={commitRename}
              />
            ) : (
              <span
                className={`truncate max-w-[130px]${file.isPreview ? ' italic' : ''}`}
                style={tabStatusColor ? { color: tabStatusColor } : undefined}
                onDoubleClick={(e) => {
                  // Why: the outer tab's onDoubleClick pins preview tabs. Scope
                  // rename to the filename text only so pin-on-dblclick still
                  // works anywhere else on the tab chrome (matching VS Code).
                  if (!canRename) {
                    return
                  }
                  e.stopPropagation()
                  setIsRenaming(true)
                }}
              >
                {getEditorDisplayLabel(file)}
              </span>
            )}
            {tabStatus && !isRenaming && (
              <span
                className="shrink-0 text-[10px] leading-none font-semibold tracking-wide"
                style={{ color: tabStatusColor }}
              >
                {STATUS_LABELS[tabStatus]}
              </span>
            )}
          </span>
          {/* Dirty dot and close button share the same slot to prevent tab width shift during auto-save.
             When dirty: dot is shown, close button appears on hover (replacing the dot).
             When clean: close button is shown normally (visible on active tab, on hover for others). */}
          <div className="relative flex items-center justify-center w-4 h-4 shrink-0">
            {file.isDirty && (
              <span className="absolute size-1.5 rounded-full bg-foreground/60 group-hover:hidden" />
            )}
            <button
              className={`flex items-center justify-center w-4 h-4 rounded-sm ${
                file.isDirty
                  ? 'hidden group-hover:flex text-muted-foreground hover:text-foreground hover:bg-muted'
                  : isActive
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
          </div>
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
          <DropdownMenuItem onSelect={() => onSplitGroup('up', file.tabId ?? file.id)}>
            <Rows2 className="mr-1.5 size-3.5" />
            Split Up
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('down', file.tabId ?? file.id)}>
            <Rows2 className="mr-1.5 size-3.5" />
            Split Down
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('left', file.tabId ?? file.id)}>
            <Columns2 className="mr-1.5 size-3.5" />
            Split Left
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => onSplitGroup('right', file.tabId ?? file.id)}>
            <Columns2 className="mr-1.5 size-3.5" />
            Split Right
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onClose}>Close</DropdownMenuItem>
          <DropdownMenuItem onSelect={onCloseAll}>Close All Editor Tabs</DropdownMenuItem>
          <DropdownMenuItem onSelect={onCloseToRight} disabled={!hasTabsToRight}>
            Close Tabs To The Right
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              void window.api.ui.writeClipboardText(file.filePath)
            }}
          >
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            Copy Path
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => {
              void window.api.ui.writeClipboardText(file.relativePath)
            }}
          >
            <Copy className="w-3.5 h-3.5 mr-1.5" />
            Copy Relative Path
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              window.api.shell.openPath(file.filePath)
            }}
          >
            <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
            {revealLabel}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
