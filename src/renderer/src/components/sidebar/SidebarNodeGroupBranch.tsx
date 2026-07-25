import React from 'react'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ChevronRight } from 'lucide-react'
import type { PanelTreeGroup, PinnedTerminalPanel } from '../../../../shared/types'
import {
  childrenOfGroup,
  PANEL_TREE_ROOT_NODES,
  panelsInGroup
} from '../../../../shared/panel-tree'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { RowRenameInput, SortableTerminalPanelButton } from './SidebarPanelRows'

export function NodeGroupBranch({
  group,
  allGroups,
  panels,
  depth,
  collapsedKeys,
  activeView,
  activePanelId,
  onToggle,
  onOpen,
  onRename,
  onDelete,
  onAddChild
}: {
  group: PanelTreeGroup
  allGroups: readonly PanelTreeGroup[]
  panels: readonly PinnedTerminalPanel[]
  depth: number
  collapsedKeys: ReadonlySet<string>
  activeView: string
  activePanelId: string | null
  onToggle: (key: string) => void
  onOpen: (panelId: string) => void
  onRename: (groupId: string, title: string) => void
  onDelete: (groupId: string) => void
  onAddChild: (parentId: string) => void
}): React.JSX.Element {
  const [renaming, setRenaming] = React.useState(false)
  // Why: fold keys are group.id only. Legacy string-group folds stored the
  // title ("node-e") in collapsedPinnedTerminalPanelGroups; if we OR title
  // into collapsed forever, expand (which toggles id) never opens the branch.
  const foldKey = group.id
  const collapsed = collapsedKeys.has(foldKey)
  const members = panelsInGroup(panels, group.id)
  const childGroups = childrenOfGroup(allGroups, PANEL_TREE_ROOT_NODES, group.id)
  const indent = depth === 0 ? 'pl-4' : depth === 1 ? 'pl-6' : 'pl-8'
  const hasActive =
    members.some((p) => activeView === 'terminal-panel' && activePanelId === p.id) ||
    childGroups.some((child) =>
      panelsInGroup(panels, child.id).some(
        (p) => activeView === 'terminal-panel' && activePanelId === p.id
      )
    )

  if (renaming) {
    return (
      <RowRenameInput
        initialTitle={group.title}
        indentClass={indent}
        onCommit={(title) => onRename(group.id, title)}
        onDone={() => setRenaming(false)}
      />
    )
  }

  return (
    <div data-panel-group-id={group.id}>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            id={`group:${group.id}`}
            onClick={() => onToggle(foldKey)}
            aria-expanded={!collapsed}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[11px] font-semibold tracking-wide uppercase transition-colors',
              indent,
              collapsed && hasActive
                ? 'text-worktree-sidebar-accent-foreground'
                : 'text-worktree-sidebar-foreground/40 hover:text-worktree-sidebar-foreground/70'
            )}
          >
            <ChevronRight
              className={cn('size-3 shrink-0 transition-transform', !collapsed && 'rotate-90')}
              strokeWidth={2}
            />
            <span className="min-w-0 flex-1 truncate">{group.title}</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setRenaming(true)}>
            {translate('auto.components.sidebar.SidebarPanelsNav.renamePanel', 'Rename')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => onAddChild(group.id)}>
            {translate(
              'auto.components.sidebar.SidebarPanelsNav.addChildGroup',
              'Add nested group'
            )}
          </ContextMenuItem>
          <ContextMenuItem variant="destructive" onSelect={() => onDelete(group.id)}>
            {translate('auto.components.sidebar.SidebarPanelsNav.deleteGroup', 'Delete group')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      {collapsed ? null : (
        <>
          <SortableContext
            items={members.map((panel) => panel.id)}
            strategy={verticalListSortingStrategy}
          >
            {members.map((panel) => (
              <SortableTerminalPanelButton
                key={panel.id}
                panel={panel}
                nested
                active={activeView === 'terminal-panel' && activePanelId === panel.id}
                onOpen={onOpen}
              />
            ))}
          </SortableContext>
          {childGroups.map((child) => (
            <NodeGroupBranch
              key={child.id}
              group={child}
              allGroups={allGroups}
              panels={panels}
              depth={depth + 1}
              collapsedKeys={collapsedKeys}
              activeView={activeView}
              activePanelId={activePanelId}
              onToggle={onToggle}
              onOpen={onOpen}
              onRename={onRename}
              onDelete={onDelete}
              onAddChild={onAddChild}
            />
          ))}
        </>
      )}
    </div>
  )
}
