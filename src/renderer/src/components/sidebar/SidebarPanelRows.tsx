import React from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { Globe, LayoutGrid, SquareTerminal } from 'lucide-react'
import { useAppStore } from '@/store'
import type { PanelLayout, PinnedTerminalPanel, PinnedWebPanel } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { detachPanelIntoWindow } from '@/lib/panel-canvas-detach'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { buildSplitCandidates } from '@/lib/panel-split-candidates'

// Why: zustand useSyncExternalStore + `?? []` → new [] every snapshot when
// settings are unset → React #185 (same class as QuickAddPanelPopovers).
const EMPTY_TERMINAL_PANELS: PinnedTerminalPanel[] = []
const EMPTY_WEB_PANELS: PinnedWebPanel[] = []

/** Inline title editor shown in place of a row while renaming. Commits on
 *  Enter/blur, cancels on Escape; empty titles cancel instead of committing. */
export function RowRenameInput({
  initialTitle,
  indentClass,
  onCommit,
  onDone
}: {
  initialTitle: string
  indentClass?: string
  onCommit: (title: string) => void
  onDone: () => void
}): React.JSX.Element {
  const [title, setTitle] = React.useState(initialTitle)
  const commit = (): void => {
    const trimmed = title.trim()
    if (trimmed.length > 0 && trimmed !== initialTitle) {
      onCommit(trimmed)
    }
    onDone()
  }
  return (
    <div className={cn('flex w-full items-center py-0.5 pr-2', indentClass ?? 'pl-2')}>
      <Input
        autoFocus
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit()
          } else if (event.key === 'Escape') {
            onDone()
          }
        }}
        className="h-6 w-full text-[13px]"
        aria-label={translate('auto.components.sidebar.SidebarPanelRows.renameLabel', 'Rename')}
      />
    </div>
  )
}

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

/** Right-click affordance shared by both panel row kinds: opens a split
 *  picker (other panels / blank / duplicate), never silent-clones alone. */
function PanelCanvasContextMenu({
  kind,
  panelId,
  title,
  host,
  onRename,
  children
}: {
  kind: 'terminal' | 'web'
  panelId: string
  title: string
  host?: string | null
  onRename: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const openCanvasSplitFromSource = useAppStore((s) => s.openCanvasSplitFromSource)
  const openPanelInCanvas = useAppStore((s) => s.openPanelInCanvas)
  const terminalPanels = useAppStore(
    (s) => s.settings?.pinnedTerminalPanels ?? EMPTY_TERMINAL_PANELS
  )
  const webPanels = useAppStore((s) => s.settings?.pinnedWebPanels ?? EMPTY_WEB_PANELS)
  const items = React.useMemo(
    () =>
      buildSplitCandidates({
        source:
          kind === 'terminal'
            ? { kind: 'terminal', panelId, host: host ?? null }
            : { kind: 'web', panelId },
        terminalPanels,
        webPanels,
        includeDuplicate: true
      }),
    [kind, panelId, host, terminalPanels, webPanels]
  )
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[14rem]">
        <ContextMenuItem onSelect={onRename}>
          {translate('auto.components.sidebar.SidebarPanelsNav.renamePanel', 'Rename')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => openPanelInCanvas({ kind, panelId }, 'row')}>
          {translate('auto.components.sidebar.SidebarPanelsNav.openInCanvas', 'Open in canvas')}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {translate(
              'auto.components.sidebar.SidebarPanelsNav.canvasSplitRight',
              'Add to canvas (split right)'
            )}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-[14rem]">
            {items.map((item) => (
              <ContextMenuItem
                key={`row:${item.id}`}
                onSelect={() => openCanvasSplitFromSource({ kind, panelId }, 'row', item.choice)}
              >
                <span className="flex flex-col items-start gap-0.5">
                  <span>{item.label}</span>
                  {item.subtitle ? (
                    <span className="max-w-[14rem] truncate font-mono text-[10px] text-muted-foreground">
                      {item.subtitle}
                    </span>
                  ) : null}
                </span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            {translate(
              'auto.components.sidebar.SidebarPanelsNav.canvasSplitDown',
              'Add to canvas (split down)'
            )}
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-[14rem]">
            {items.map((item) => (
              <ContextMenuItem
                key={`col:${item.id}`}
                onSelect={() => openCanvasSplitFromSource({ kind, panelId }, 'column', item.choice)}
              >
                <span className="flex flex-col items-start gap-0.5">
                  <span>{item.label}</span>
                  {item.subtitle ? (
                    <span className="max-w-[14rem] truncate font-mono text-[10px] text-muted-foreground">
                      {item.subtitle}
                    </span>
                  ) : null}
                </span>
              </ContextMenuItem>
            ))}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuItem onSelect={() => detachPanelIntoWindow(kind, panelId, title)}>
          {translate('auto.components.sidebar.SidebarPanelsNav.detachPanel', 'Open in new window')}
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
  const [renaming, setRenaming] = React.useState(false)
  const updateSettings = useAppStore((s) => s.updateSettings)
  if (renaming) {
    return (
      <RowRenameInput
        initialTitle={panel.title}
        indentClass="pl-8"
        onCommit={(title) => {
          const panels = useAppStore.getState().settings?.pinnedWebPanels ?? []
          void updateSettings({
            pinnedWebPanels: panels.map((p) => (p.id === panel.id ? { ...p, title } : p))
          })
        }}
        onDone={() => setRenaming(false)}
      />
    )
  }
  return (
    <PanelCanvasContextMenu
      kind="web"
      panelId={panel.id}
      title={panel.title}
      onRename={() => setRenaming(true)}
    >
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
  const [renaming, setRenaming] = React.useState(false)
  const updateSettings = useAppStore((s) => s.updateSettings)
  if (renaming) {
    return (
      <RowRenameInput
        initialTitle={panel.title}
        indentClass={nested ? 'pl-8' : 'pl-2'}
        onCommit={(title) => {
          const panels = useAppStore.getState().settings?.pinnedTerminalPanels ?? []
          void updateSettings({
            pinnedTerminalPanels: panels.map((p) => (p.id === panel.id ? { ...p, title } : p))
          })
        }}
        onDone={() => setRenaming(false)}
      />
    )
  }
  return (
    <PanelCanvasContextMenu
      kind="terminal"
      panelId={panel.id}
      title={panel.title}
      host={panel.host ?? null}
      onRename={() => setRenaming(true)}
    >
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
  const [renaming, setRenaming] = React.useState(false)
  const updateSettings = useAppStore((s) => s.updateSettings)
  if (renaming) {
    return (
      <RowRenameInput
        initialTitle={layout.title}
        onCommit={(title) => {
          const layouts = useAppStore.getState().settings?.panelLayouts ?? []
          void updateSettings({
            panelLayouts: layouts.map((l) => (l.id === layout.id ? { ...l, title } : l))
          })
        }}
        onDone={() => setRenaming(false)}
      />
    )
  }
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
        <ContextMenuItem onSelect={() => setRenaming(true)}>
          {translate('auto.components.sidebar.SidebarPanelsNav.renamePanel', 'Rename')}
        </ContextMenuItem>
        <ContextMenuItem variant="destructive" onSelect={() => onDelete(layout.id)}>
          {translate('auto.components.sidebar.SidebarPanelsNav.deleteLayout', 'Delete layout')}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
