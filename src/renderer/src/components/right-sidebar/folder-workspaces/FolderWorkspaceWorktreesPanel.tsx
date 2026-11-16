import {
  selectSidebarLineageParentIdentities,
  selectCrossStoreFolderChildrenById
} from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import WorktreeCard from '@/components/sidebar/workspace-card/surface/WorktreeCard'
import { stopNestedWorktreeCardBubble } from '@/components/sidebar/worktree-list/rows/header-event-guards'
import {
  getLineageChildrenInlineStyle,
  LINEAGE_CHILDREN_INLINE_OFFSET
} from '@/components/sidebar/worktree-list/rows/indentation'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import { resolveReviewRepository } from '@/lib/source-control/review/review-owner'
import { getAttachedWorktreesForFolderWorkspace } from './folder-workspace-attached-worktrees'
import { useState } from 'react'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { FolderWorkspaceEmptyState } from './folder-workspace-empty-state'
import type { Worktree } from '../../../../../shared/worktree/types'

export default function FolderWorkspaceWorktreesPanel(): React.JSX.Element {
  const t = useTranslate()
  const executionHostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceKey = useAppStore((s) => s.activeWorkspaceKey)
  const folderWorkspaces = useAppStore((s) => selectFolderWorkspaces(s))
  const workspaceLineageByChildKey = useAppStore((s) => s.workspaceLineageByChildKey)
  const worktreeLineageById = useAppStore((s) => s.worktreeLineageById)
  const lineageParentIdentities = useAppStore(selectSidebarLineageParentIdentities)
  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const crossStoreChildrenByFolderId = useAppStore(selectCrossStoreFolderChildrenById)
  const repos = useAppStore((s) => s.repos)
  const [collapsedLineageWorktreeIds, setCollapsedLineageWorktreeIds] = useState<
    ReadonlySet<string>
  >(() => new Set())

  const { folderWorkspace, childWorktrees, lineageChildrenByParentId, rootChildWorktrees } =
    getAttachedWorktreesForFolderWorkspace({
      executionHostId,
      activeWorkspaceKey,
      activeWorktreeId,
      folderWorkspaces,
      workspaceLineageByChildKey,
      lineageParentIdentities,
      worktreeLineageById,
      worktreesByRepo,
      crossStoreChildrenByFolderId
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
    const identity = getWorktreeHostIdentity(worktree)
    const lineageChildren = lineageChildrenByParentId.get(identity) ?? []
    const lineageCollapsed = collapsedLineageWorktreeIds.has(identity)
    const nextAncestorIds = new Set([...ancestorIds, identity])
    const safeLineageChildren = lineageChildren.filter(
      (child) => !nextAncestorIds.has(getWorktreeHostIdentity(child))
    )
    const hasSafeLineageChildren = safeLineageChildren.length > 0
    return (
      <WorktreeCard
        key={identity}
        worktree={worktree}
        repo={resolveReviewRepository(repos, worktree) ?? undefined}
        isActive={activeWorktreeId === worktree.id}
        isActiveSurface={false}
        hideRepoBadge={false}
        nativeDragEnabled={false}
        flushSurface
        contentIndent={0}
        affiliateListMode
        lineageChildCount={safeLineageChildren.length}
        lineageCollapsed={lineageCollapsed}
        lineageChildren={
          !lineageCollapsed && hasSafeLineageChildren
            ? safeLineageChildren.map((child) => (
                <div
                  key={getWorktreeHostIdentity(child)}
                  onClick={stopNestedWorktreeCardBubble}
                  onDoubleClick={stopNestedWorktreeCardBubble}
                  onDragStart={stopNestedWorktreeCardBubble}
                >
                  {renderChildWorktree(child, nextAncestorIds)}
                </div>
              ))
            : undefined
        }
        lineageChildrenStyle={
          hasSafeLineageChildren
            ? getLineageChildrenInlineStyle(LINEAGE_CHILDREN_INLINE_OFFSET)
            : undefined
        }
        onLineageToggle={
          hasSafeLineageChildren
            ? (event) => {
                event.preventDefault()
                event.stopPropagation()
                toggleLineage(identity)
              }
            : undefined
        }
      />
    )
  }

  if (!folderWorkspace) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
        {t(
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
          {t(
            'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.attachedCount',
            '{{count}} attached worktrees',
            { count: childWorktrees.length, defaultValue_one: '{{count}} attached worktree' }
          )}
        </div>
      </div>

      {childWorktrees.length === 0 ? (
        <FolderWorkspaceEmptyState
          folderWorkspace={folderWorkspace}
          title={t(
            'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.emptyTitle',
            'No attached worktrees yet'
          )}
          copy={t(
            'auto.components.rightSidebar.FolderWorkspaceWorktreesPanel.emptyCopy',
            'Worktrees created from this workspace will show up here.'
          )}
        />
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
