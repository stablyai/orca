import { useSortable } from '@dnd-kit/sortable'
import { Folder, GitBranch, Trash2, X } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator
} from '@/components/ui/context-menu'
import { deleteMultiplexerWorktree } from './delete-multiplexer-worktree'
import { reviewStateLabel } from '@/components/dashboard-popout/agent-dashboard-filter-options'
import { resolveRepoHeaderColor } from '@/components/sidebar/project-header-color'
import { getReviewLabel, ReviewIcon } from '@/components/sidebar/worktree-review-helpers'
import { translate } from '@/i18n/i18n'
import type { WorkspaceMultiplexerSlot } from '../../../../shared/workspace-multiplexer-types'
import {
  getDropIndicatorClasses,
  getTabRootStateClasses,
  getTabStripBorderClasses,
  type DropIndicator
} from '../tab-bar/drop-indicator'
import { TAB_CONTAINER_WIDTH_CLASSES } from '../tab-bar/tab-width-rules'
import { useTabStripPointerActivation } from '../tab-bar/tab-strip-pointer-activation'
import type { WorkspaceMultiplexerSlotDragData } from './WorkspaceMultiplexerDragScope'
import type { WorkspaceMultiplexerCatalogItem } from './workspace-multiplexer-model'

export type WorkspaceMultiplexerTabItem = {
  slot: WorkspaceMultiplexerSlot
  workspace: WorkspaceMultiplexerCatalogItem | null
}

export function WorkspaceMultiplexerWorkspaceTab({
  paneId,
  item,
  active,
  hasTabsToRight,
  dropIndicator,
  onActivate,
  onRemove,
  onMove
}: {
  paneId: string
  item: WorkspaceMultiplexerTabItem
  active: boolean
  hasTabsToRight: boolean
  dropIndicator: DropIndicator
  onActivate: () => void
  onRemove: () => void
  onMove: (offset: -1 | 1) => void
}): React.JSX.Element {
  const { slot, workspace } = item
  const projectName =
    workspace?.projectName ??
    translate(
      'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.unknownProject',
      'Unknown project'
    )
  const workspaceName = workspace?.workspaceName ?? slot.worktreeId
  const reviewLabel = workspace?.review
    ? `${getReviewLabel(workspace.review)}: ${reviewStateLabel(workspace.review.state)}`
    : null
  const tabLabel = [workspaceName, projectName, reviewLabel].filter(Boolean).join(' — ')
  const { attributes, listeners, setNodeRef } = useSortable({
    id: `workspace-multiplexer-slot:${slot.id}`,
    data: {
      kind: 'workspace-multiplexer-slot',
      slotId: slot.id,
      paneId,
      projectName,
      workspaceName,
      projectBadgeColor: workspace?.projectBadgeColor ?? null
    } satisfies WorkspaceMultiplexerSlotDragData
  })
  const { onPointerDown } = useTabStripPointerActivation({ onActivate, disabled: false })
  const removeLabel = translate(
    'auto.components.workspace.multiplexer.WorkspaceMultiplexerTile.removeNamed',
    'Remove {{value0}} from Workspace Multiplexer',
    { value0: workspaceName }
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={setNodeRef}
          data-workspace-multiplexer-drag-handle=""
          data-workspace-multiplexer-tab-id={slot.id}
          data-review-state={workspace?.review?.state ?? undefined}
          data-active={active ? 'true' : 'false'}
          {...attributes}
          {...listeners}
          aria-label={tabLabel}
          title={tabLabel}
          className={`group relative flex h-full cursor-pointer select-none items-center gap-1.5 px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring ${TAB_CONTAINER_WIDTH_CLASSES} ${getTabStripBorderClasses(hasTabsToRight, { includeTopBorder: false })} ${getDropIndicatorClasses(dropIndicator)} ${getTabRootStateClasses(active)}`}
          onPointerDown={(event) =>
            onPointerDown(
              event,
              listeners?.onPointerDown as ((event: React.PointerEvent<Element>) => void) | undefined
            )
          }
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) {
              return
            }
            if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
              event.preventDefault()
              onMove(-1)
            } else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
              event.preventDefault()
              onMove(1)
            } else if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              onActivate()
            }
          }}
        >
          {workspace ? (
            <span
              className="inline-flex size-5 shrink-0 items-center justify-center"
              data-workspace-multiplexer-workspace-icon=""
              data-workspace-multiplexer-review-state={workspace.review?.state}
              aria-hidden="true"
            >
              {workspace.workspaceKind === 'folder' ? (
                <Folder
                  className="size-3.5"
                  style={{ color: resolveRepoHeaderColor(workspace.projectBadgeColor) }}
                />
              ) : workspace.review ? (
                <ReviewIcon review={workspace.review} className="size-3.5" variant="generic" />
              ) : (
                <GitBranch
                  className="size-3.5"
                  style={{ color: resolveRepoHeaderColor(workspace.projectBadgeColor) }}
                />
              )}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 leading-tight">
            <span
              className="block truncate font-semibold text-foreground"
              data-workspace-multiplexer-workspace-name=""
            >
              {workspaceName}
            </span>
            <span
              className="block truncate text-muted-foreground"
              data-workspace-multiplexer-project-name=""
            >
              {projectName}
            </span>
          </span>
          <button
            type="button"
            className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 hover:bg-accent hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={removeLabel}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              onRemove()
            }}
          >
            <X className="size-3" />
          </button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onRemove}>
          <X />
          {removeLabel}
        </ContextMenuItem>
        {workspace?.workspaceKind === 'worktree' && !workspace.isMainWorktree ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => deleteMultiplexerWorktree(slot)}>
              <Trash2 />
              {translate('multiplexer.deleteWorktree', 'Delete worktree…')}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
