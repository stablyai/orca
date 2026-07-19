import React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { Globe, LayoutGrid, SquareTerminal } from 'lucide-react'
import { useAppStore } from '@/store'
import type { PanelLayout, PinnedTerminalPanel, PinnedWebPanel } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'

function sortableRowStyle(
  transform: { x: number; y: number } | null,
  transition: string | undefined
): React.CSSProperties {
  return {
    // Why: @dnd-kit/utilities isn't a dependency; the translate string is
    // trivial to build and sortable only ever needs a translation.
    transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
    transition
  }
}

/** Right-click affordance shared by both panel row kinds: sends the panel
 *  into the split canvas (seeding it when closed, splitting when open). */
function PanelCanvasContextMenu({
  kind,
  panelId,
  children
}: {
  kind: 'terminal' | 'web'
  panelId: string
  children: React.ReactNode
}): React.JSX.Element {
  const openPanelInCanvas = useAppStore((s) => s.openPanelInCanvas)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => openPanelInCanvas({ kind, panelId }, 'row')}>
          {translate(
            'auto.components.sidebar.SidebarPanelsNav.canvasSplitRight',
            'Add to canvas (split right)'
          )}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => openPanelInCanvas({ kind, panelId }, 'column')}>
          {translate(
            'auto.components.sidebar.SidebarPanelsNav.canvasSplitDown',
            'Add to canvas (split down)'
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function SortableWebPanelButton({
  panel,
  active,
  onOpen
}: {
  panel: PinnedWebPanel
  active: boolean
  onOpen: (panelId: string) => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: panel.id
  })
  return (
    <PanelCanvasContextMenu kind="web" panelId={panel.id}>
      <button
        ref={setNodeRef}
        style={sortableRowStyle(transform, transition)}
        type="button"
        {...attributes}
        {...listeners}
        onClick={() => onOpen(panel.id)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-8 text-left text-[13px] font-medium tracking-tight transition-colors',
          isDragging && 'relative z-10 opacity-80 shadow-md',
          active
            ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
            : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
        )}
      >
        <Globe
          className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
          strokeWidth={active ? 2.25 : 1.75}
        />
        <span className="min-w-0 flex-1 truncate">{panel.title}</span>
      </button>
    </PanelCanvasContextMenu>
  )
}

export function SortableTerminalPanelButton({
  panel,
  active,
  nested = false,
  onOpen
}: {
  panel: PinnedTerminalPanel
  active: boolean
  nested?: boolean
  onOpen: (panelId: string) => void
}): React.JSX.Element {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: panel.id
  })
  return (
    <PanelCanvasContextMenu kind="terminal" panelId={panel.id}>
      <button
        ref={setNodeRef}
        style={sortableRowStyle(transform, transition)}
        type="button"
        {...attributes}
        {...listeners}
        onClick={() => onOpen(panel.id)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-[13px] font-medium tracking-tight transition-colors',
          nested ? 'pl-8' : 'pl-2',
          isDragging && 'relative z-10 opacity-80 shadow-md',
          active
            ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
            : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
        )}
      >
        <SquareTerminal
          className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
          strokeWidth={active ? 2.25 : 1.75}
        />
        <span className="min-w-0 flex-1 truncate">{panel.title}</span>
      </button>
    </PanelCanvasContextMenu>
  )
}

export function PanelLayoutButton({
  layout,
  active,
  onOpen,
  onDelete
}: {
  layout: PanelLayout
  active: boolean
  onOpen: (layout: PanelLayout) => void
  onDelete: (layoutId: string) => void
}): React.JSX.Element {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => onOpen(layout)}
          aria-current={active ? 'page' : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md py-1.5 pr-2 pl-2 text-left text-[13px] font-medium tracking-tight transition-colors',
            active
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
              : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
          )}
        >
          <LayoutGrid
            className={cn('size-4 shrink-0', !active && 'text-worktree-sidebar-foreground/30')}
            strokeWidth={active ? 2.25 : 1.75}
          />
          <span className="min-w-0 flex-1 truncate">{layout.title}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(layout.id)}>
          {translate('auto.components.sidebar.SidebarPanelsNav.deleteLayout', 'Delete layout')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
