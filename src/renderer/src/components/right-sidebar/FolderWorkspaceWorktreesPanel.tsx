import WorktreeCard from '@/components/sidebar/WorktreeCard'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../shared/types'
import { getAttachedWorktreesForFolderWorkspace } from './folder-workspace-attached-worktrees'
import { useState } from 'react'

function stopNestedWorktreeCardBubble(event: React.SyntheticEvent<HTMLElement>): void {
  event.stopPropagation()
}

export default function FolderWorkspaceWorktreesPanel(): React.JSX.Element {
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceKey = useAppStore((s) => s.activeWorkspaceKey)
  const folderWorkspaces = useAppStore((s) => s.folderWorkspaces)
  const workspaceLineageByChildKey = useAppStore((s) => s.workspaceLineageByChildKey)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const [collapsedLineageWorktreeIds, setCollapsedLineageWorktreeIds] = useState<
    ReadonlySet<string>
  >(() => new Set())

  const repoById = new Map(repos.map((repo) => [repo.id, repo]))
  const { folderWorkspace, childWorktrees, lineageChildrenByParentId, rootChildWorktrees } =
    getAttachedWorktreesForFolderWorkspace({
      activeWorkspaceKey,
      activeWorktreeId,
      folderWorkspaces,
      workspaceLineageByChildKey,
      worktreeLineageById,
      worktreesByRepo
    })

  const toggleLineage = (worktreeId: string): void => {
    setCollapsedLineageWorktreeIds((current) => {
      const next = new Set(current)
      if (next.has(worktreeId)) {
        next.delete(worktreeId)
      } else {
        next.add(worktreeId)
      }
      return next
    })
  }

  const renderChildWorktree = (
    worktree: Worktree,
    ancestorIds: ReadonlySet<string> = new Set()
  ): React.JSX.Element => {
    const lineageChildren = lineageChildrenByParentId.get(worktree.id) ?? []
    const lineageCollapsed = collapsedLineageWorktreeIds.has(worktree.id)
    const nextAncestorIds = new Set([...ancestorIds, worktree.id])
    const safeLineageChildren = lineageChildren.filter((child) => !nextAncestorIds.has(child.id))
    return (
      <WorktreeCard
        key={worktree.id}
        worktree={worktree}
        repo={repoById.get(worktree.repoId)}
        isActive={activeWorktreeId === worktree.id}
        isActiveSurface={false}
        hideRepoBadge={false}
        nativeDragEnabled={false}
        flushSurface
        affiliateListMode
        lineageChildCount={safeLineageChildren.length}
        lineageCollapsed={lineageCollapsed}
        lineageChildren={
          !lineageCollapsed && safeLineageChildren.length > 0
            ? safeLineageChildren.map((child) => (
                <div
                  key={child.id}
                  onClick={stopNestedWorktreeCardBubble}
                  onDoubleClick={stopNestedWorktreeCardBubble}
                  onDragStart={stopNestedWorktreeCardBubble}
                >
                  {renderChildWorktree(child, nextAncestorIds)}
                </div>
              ))
            : undefined
        }
        onLineageToggle={
          safeLineageChildren.length > 0
            ? (event) => {
                event.preventDefault()
                event.stopPropagation()
                toggleLineage(worktree.id)
              }
            : undefined
        }
      />
    )
  }

  if (!folderWorkspace) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {translate(
          'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.unavailable',
          'Workspaces are only shown for folder workspaces.'
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      <div className="border-b border-border px-4 py-3">
        <div className="truncate text-sm font-medium text-foreground">{folderWorkspace.name}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {childWorktrees.length === 1
            ? translate(
                'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.countOne',
                '1 attached worktree'
              )
            : translate(
                'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.countMany',
                '{{value0}} attached worktrees',
                { value0: childWorktrees.length }
              )}
        </div>
      </div>

      {childWorktrees.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
          <div className="text-sm font-medium text-foreground">
            {translate(
              'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.emptyTitle',
              'No attached worktrees yet'
            )}
          </div>
          <div className="mt-2 max-w-[16rem] text-xs leading-5 text-muted-foreground">
            {translate(
              'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.emptyCopy',
              'Worktrees created from this workspace will show up here.'
            )}
          </div>
        </div>
      ) : (
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto py-2 pl-1 pr-2">
          <div className="space-y-1">
            {rootChildWorktrees.map((worktree) => renderChildWorktree(worktree))}
          </div>
        </div>
      )}
    </div>
  )
}
