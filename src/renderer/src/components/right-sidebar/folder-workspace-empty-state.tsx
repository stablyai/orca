import { useState } from 'react'
import { FolderGit2, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { findIndexedProjectGroupOwner } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderSourceRepos } from '../../../../shared/folder-workspaces/folder-workspace-source-repos'
import type { Repo } from '../../../../shared/repo-types'
import { createFolderRepoWorktree } from './folder-workspace-repo-worktree-create'

type FolderWorkspaceEmptyStateProps = {
  folderWorkspace: FolderWorkspace | null
  title: string
  copy: string
}

/** A folder workspace with no attached worktrees: its copy, then one create row per repository. */
export function FolderWorkspaceEmptyState({
  folderWorkspace,
  title,
  copy
}: FolderWorkspaceEmptyStateProps): React.JSX.Element {
  const repos = useAppStore((s) => s.repos)
  const projectGroups = useAppStore((s) => s.projectGroups)
  const [creatingRepoIds, setCreatingRepoIds] = useState<ReadonlySet<string>>(() => new Set())

  const projectGroup = folderWorkspace
    ? findIndexedProjectGroupOwner(
        projectGroups,
        folderWorkspace.projectGroupId,
        folderWorkspace.executionHostId ?? undefined
      )
    : null
  const folderRepos = getFolderSourceRepos(repos, projectGroups, projectGroup)

  const create = (repo: Repo): void => {
    if (!folderWorkspace) {
      return
    }
    setCreatingRepoIds((current) => new Set(current).add(repo.id))
    void createFolderRepoWorktree(folderWorkspace, repo).finally(() =>
      setCreatingRepoIds((current) => {
        const next = new Set(current)
        next.delete(repo.id)
        return next
      })
    )
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-2 text-center">
      <div className="px-4 text-sm font-medium text-foreground">{title}</div>
      <div className="mt-2 max-w-64 px-4 text-xs leading-5 text-muted-foreground">{copy}</div>
      {folderRepos.length > 0 ? (
        <ul className="mt-4 flex w-full max-w-72 flex-col gap-1 text-left">
          {folderRepos.map((repo) => {
            const creating = creatingRepoIds.has(repo.id)
            return (
              <li
                key={repo.id}
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-md px-2 py-1 hover:bg-accent/50"
              >
                <span className="flex min-w-16 flex-1 items-center gap-2">
                  <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
                  <span
                    className="min-w-0 flex-1 truncate text-xs text-foreground"
                    title={repo.path}
                  >
                    {repo.displayName}
                  </span>
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={creating}
                  onClick={() => create(repo)}
                >
                  {creating ? <LoaderCircle className="animate-spin" /> : null}
                  {translate(
                    'auto.components.rightSidebar.FolderWorkspaceEmptyState.createWorktree',
                    'Create worktree'
                  )}
                </Button>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
