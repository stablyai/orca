import React, { useMemo } from 'react'
import { ArchiveRestore } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { useAllWorktrees, useRepoMap } from '@/store/selectors'
import { resolveWorktreeDisplayName } from '@/lib/worktree-default-display-name'
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../shared/worktree/types'
import { runRestoreArchivedWorktree } from './archive-worktree-flow'

export function getArchivedWorktreesNewestFirst(worktrees: readonly Worktree[]): Worktree[] {
  return worktrees
    .filter((worktree) => worktree.isArchived)
    .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
}

type SidebarArchivedWorkspacesMenuSectionProps = {
  preserveWorkspaceBoardOpen: boolean
}

const SidebarArchivedWorkspacesMenuSection = React.memo(
  function SidebarArchivedWorkspacesMenuSection({
    preserveWorkspaceBoardOpen
  }: SidebarArchivedWorkspacesMenuSectionProps) {
    const allWorktrees = useAllWorktrees()
    const repoMap = useRepoMap()
    const archivedWorktrees = useMemo(
      () => getArchivedWorktreesNewestFirst(allWorktrees),
      [allWorktrees]
    )

    return (
      <>
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex flex-1 items-center justify-between">
              <span>
                {translate(
                  'auto.components.sidebar.SidebarArchivedWorkspacesMenuSection.archived',
                  'Archived'
                )}
              </span>
              <span className="text-[11px] font-medium text-muted-foreground">
                {archivedWorktrees.length}
              </span>
            </span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent
            className="w-64"
            data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
          >
            <div className="scrollbar-sleek max-h-80 overflow-y-auto">
              {archivedWorktrees.length === 0 ? (
                <DropdownMenuItem disabled>
                  {translate(
                    'auto.components.sidebar.SidebarArchivedWorkspacesMenuSection.empty',
                    'No archived workspaces. Right-click a workspace → Archive.'
                  )}
                </DropdownMenuItem>
              ) : null}
              {archivedWorktrees.map((worktree) => (
                <DropdownMenuItem
                  key={worktree.id}
                  onSelect={() => void runRestoreArchivedWorktree(worktree.id)}
                  title={translate(
                    'auto.components.sidebar.SidebarArchivedWorkspacesMenuSection.restore',
                    'Restore and open'
                  )}
                >
                  <ArchiveRestore className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate">
                    {resolveWorktreeDisplayName(worktree)}
                  </span>
                  <span className="max-w-[40%] truncate text-[11px] text-muted-foreground">
                    {repoMap.get(worktree.repoId)?.displayName}
                  </span>
                </DropdownMenuItem>
              ))}
            </div>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </>
    )
  }
)

export default SidebarArchivedWorkspacesMenuSection
