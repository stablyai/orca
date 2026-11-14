import { memo, useMemo, useSyncExternalStore } from 'react'
import { FolderGit2, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { recomputeOn } from '@/lib/recompute-on'
import { findIndexedProjectGroupOwner } from '@/lib/workspace/ownership/worktree-runtime-owner-index'
import {
  getRepoExecutionHostId,
  getSshTargetIdForExecutionHost
} from '../../../../shared/execution-host'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import { getFolderSourceRepos } from '../../../../shared/folder-workspaces/folder-workspace-source-repos'
import {
  createFolderRepoWorktree,
  getFolderRepoCreatesVersion,
  isFolderRepoCreatePending,
  subscribeFolderRepoCreates
} from './folder-workspace-repo-worktree-create'

type FolderWorkspaceEmptyStateProps = {
  folderWorkspace: FolderWorkspace | null
  title: string
  copy: string
  /** False when worktrees are attached but this panel can't show them, so creating would duplicate. */
  showRepoActions?: boolean
}

/** A folder workspace with no attached worktrees: its copy, then one create row per repository. */
export const FolderWorkspaceEmptyState = memo(function FolderWorkspaceEmptyState({
  folderWorkspace,
  title,
  copy,
  showRepoActions = true
}: FolderWorkspaceEmptyStateProps): React.JSX.Element {
  const t = useTranslate()
  const repos = useAppStore((s) => s.repos)
  const projectGroups = useAppStore((s) => s.projectGroups)
  const createsVersion = useSyncExternalStore(
    subscribeFolderRepoCreates,
    getFolderRepoCreatesVersion
  )

  const folder = showRepoActions ? folderWorkspace : null
  const projectGroupId = folder?.projectGroupId
  const folderHostId = folder?.executionHostId ?? undefined
  // The panels re-render on every worktree catalog write; rescan only when the repo catalog moves.
  const folderRepos = useMemo(() => {
    const projectGroup = projectGroupId
      ? findIndexedProjectGroupOwner(projectGroups, projectGroupId, folderHostId)
      : null
    // Direct SSH hosts can't create worktrees from this app (managed hosts route as runtimes).
    return getFolderSourceRepos(repos, projectGroups, projectGroup).filter(
      (repo) => !getSshTargetIdForExecutionHost(getRepoExecutionHostId(repo))
    )
  }, [projectGroupId, folderHostId, projectGroups, repos])

  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col overflow-y-auto px-2 py-4 text-center">
      <div className="m-auto flex w-full flex-col items-center">
        <div className="px-4 text-sm font-medium text-foreground">{title}</div>
        <div className="mt-2 max-w-64 px-4 text-xs leading-5 text-muted-foreground">{copy}</div>
        {folder && folderRepos.length > 0 ? (
          <ul className="mt-4 flex w-full max-w-72 flex-col gap-1 text-left">
            {folderRepos.map((repo) => {
              const creating = recomputeOn([createsVersion], () =>
                isFolderRepoCreatePending(folder, repo)
              )
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
                    onClick={() => void createFolderRepoWorktree(folder, repo)}
                  >
                    {creating ? <LoaderCircle className="animate-spin" /> : null}
                    {t(
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
    </div>
  )
})
