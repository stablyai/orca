import React from 'react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { activateWorkspaceRepoEntry } from '@/lib/multi-repo-workspace-repo-navigation'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'
import { buildWorkspaceRepoStripModel } from './workspace-repo-strip-model'

/** One-click repo switching for the active multi-repo workspace; renders nothing anywhere else. */
export default function WorkspaceRepoStrip(): React.JSX.Element | null {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const folderWorkspaces = useAppStore((state) => selectFolderWorkspaces(state))
  const repos = useAppStore((state) => state.repos)
  const gitStatusByWorktree = useAppStore((state) => state.gitStatusByWorktree)
  const model = React.useMemo(
    () =>
      buildWorkspaceRepoStripModel({
        activeWorktreeId,
        folderWorkspaces,
        repos,
        gitStatusByWorktree
      }),
    [activeWorktreeId, folderWorkspaces, repos, gitStatusByWorktree]
  )
  if (!model) {
    return null
  }
  const { folderWorkspace, entries } = model
  return (
    <nav
      aria-label={translate('auto.components.multiRepo.strip.label', 'Repos in {{name}}', {
        name: folderWorkspace.name
      })}
      className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border px-3"
    >
      <span className="min-w-0 max-w-[40%] truncate text-xs font-medium text-foreground">
        {folderWorkspace.name}
      </span>
      <ul className="flex min-w-0 items-center gap-1 overflow-x-auto scrollbar-sleek">
        {entries.map((entry) => (
          <li key={entry.key} className="shrink-0">
            <Button
              type="button"
              size="xs"
              variant={entry.active ? 'secondary' : 'ghost'}
              aria-current={entry.active ? 'page' : undefined}
              onClick={() => activateWorkspaceRepoEntry(entry.key, folderWorkspace)}
            >
              {entry.kind === 'all'
                ? translate('auto.components.multiRepo.strip.all', 'All')
                : entry.label}
              {entry.changedCount !== null && entry.changedCount > 0 ? (
                <span className="text-muted-foreground">
                  {translate('auto.components.multiRepo.strip.changed', '{{n}} changed', {
                    n: entry.changedCount
                  })}
                </span>
              ) : null}
            </Button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
