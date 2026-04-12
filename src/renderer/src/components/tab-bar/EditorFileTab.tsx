import { useEffect, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { X, FileCode, GitCompareArrows, Copy, ShieldAlert } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { normalizeRelativePath } from '@/lib/path'
import { getEditorDisplayLabel } from '@/components/editor/editor-labels'
import { STATUS_COLORS, STATUS_LABELS } from '../right-sidebar/status-display'
import type { GitFileStatus } from '../../../../shared/types'
import type { OpenFile } from '../../store/slices/editor'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from './SortableTab'

export default function EditorFileTab({
  file,
  isActive,
  hasTabsToRight,
  statusByRelativePath,
  onActivate,
  onClose,
  onCloseToRight,
  onCloseAll,
  onPin
}: {
  file: OpenFile
  isActive: boolean
  hasTabsToRight: boolean
  statusByRelativePath: Map<string, GitFileStatus>
  onActivate: () => void
  onClose: () => void
  onCloseToRight: () => void
  onCloseAll: () => void
  onPin?: () => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: file.id
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
            <span
              className={`truncate max-w-[130px]${file.isPreview ? ' italic' : ''}`}
              style={tabStatusColor ? { color: tabStatusColor } : undefined}
            >
              {getEditorDisplayLabel(file)}
            </span>
            {tabStatus && (
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
          <DropdownMenuItem onSelect={onClose}>Close</DropdownMenuItem>
          <DropdownMenuItem onSelect={onCloseToRight} disabled={!hasTabsToRight}>
            Close Tabs To The Right
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCloseAll}>Close All Editor Tabs</DropdownMenuItem>
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
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
