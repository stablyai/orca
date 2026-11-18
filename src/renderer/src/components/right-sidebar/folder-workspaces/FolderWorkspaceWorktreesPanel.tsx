import { AttachedWorktreeCards } from '@/components/sidebar/AttachedWorktreeCards'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { getAttachedWorktreesForFolderWorkspace } from './folder-workspace-attached-worktrees'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { selectSidebarChildrenByParentIdentity } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { FolderWorkspaceEmptyState } from './folder-workspace-empty-state'

export default function FolderWorkspaceWorktreesPanel(): React.JSX.Element {
  const t = useTranslate()
  const executionHostId = useAppStore((s) => s.activeWorkspaceExecutionHostId)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorkspaceKey = useAppStore((s) => s.activeWorkspaceKey)
  const folderWorkspaces = useAppStore((s) => selectFolderWorkspaces(s))
  const childrenByParentIdentity = useAppStore(selectSidebarChildrenByParentIdentity)

  const { folderWorkspace, childWorktrees, lineageChildrenByParentIdentity } =
    getAttachedWorktreesForFolderWorkspace({
      executionHostId,
      activeWorkspaceKey,
      activeWorktreeId,
      folderWorkspaces,
      childrenByParentIdentity
    })

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
            <AttachedWorktreeCards
              roots={childWorktrees}
              lineageChildrenByParentIdentity={lineageChildrenByParentIdentity}
              affiliateListMode
            />
          </div>
        </div>
      )}
    </div>
  )
}
