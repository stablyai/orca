import { getRepoHostSummaries } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import { Workflow } from 'lucide-react'
import { useState, type JSX } from 'react'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { Button } from '@/components/ui/button'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { DeleteWorktreeDirtyChangeHint } from './DeleteWorktreeDirtyChangeHint'
import { translate } from '@/i18n/i18n'

type DeleteWorktreeLineageNoticeProps = {
  descendants: readonly Worktree[]
  dirtyChangeCountsByWorktreeId: ReadonlyMap<string, number>
}

export function DeleteWorktreeLineageNotice({
  descendants,
  dirtyChangeCountsByWorktreeId
}: DeleteWorktreeLineageNoticeProps): JSX.Element | null {
  const [expanded, setExpanded] = useState(false)
  const repos = useAppStore((state) => state.repos)
  const owners = getRepoHostSummaries(repos)
  const repoByIdentity = new Map(
    repos.map((repo) => [`${getRepoExecutionHostId(repo)}|${repo.id}`, repo])
  )
  const repoKey = (child: Worktree) => {
    const owner = owners.get(child.repoId)
    const hostId = child.hostId ?? (owner?.count === 1 ? owner.onlyHostId : undefined)
    return `${hostId ?? ''}|${child.repoId}`
  }
  const repoFor = (child: Worktree) => repoByIdentity.get(repoKey(child))
  const affectedRepos = new Map<string, { child: Worktree; count: number }>()
  for (const child of descendants) {
    const key = repoKey(child)
    const entry = affectedRepos.get(key)
    if (entry) {
      entry.count += 1
    } else {
      affectedRepos.set(key, { child, count: 1 })
    }
  }
  const childWorkspaceCount = descendants.length

  if (childWorkspaceCount === 0) {
    return null
  }

  return (
    <div className="min-w-0 max-w-full overflow-hidden rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <Workflow className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">
            {translate(
              'auto.components.sidebar.DeleteWorktreeLineageNotice.a940f3c96e',
              'Child workspaces will be deleted'
            )}
          </div>
          <div className="mt-1 text-muted-foreground">
            {childWorkspaceCount === 1
              ? translate(
                  'auto.components.sidebar.DeleteWorktreeLineageNotice.66798cc6a2',
                  'Deleting this workspace also deletes 1 child workspace.'
                )
              : translate(
                  'auto.components.sidebar.DeleteWorktreeLineageNotice.29b98bf9cd',
                  'Deleting this workspace also deletes {{value0}} child workspaces.',
                  { value0: childWorkspaceCount }
                )}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {Array.from(affectedRepos, ([key, { child, count }]) => (
              <span key={key} className="inline-flex min-w-0 items-center gap-1">
                <RepoBadgeLabel
                  name={repoFor(child)?.displayName ?? child.repoId}
                  color={repoFor(child)?.badgeColor ?? ''}
                />{' '}
                ({count})
              </span>
            ))}
          </div>
          {/* Why: long nowrap paths can otherwise give this grid child an
             intrinsic width wider than the modal. */}
          <div className="mt-2 min-w-0 max-w-full space-y-1 overflow-hidden rounded-sm border border-border/60 bg-background/60 px-2 py-1.5">
            {(expanded ? descendants : descendants.slice(0, 4)).map((child) => (
              <div key={getWorktreeHostIdentity(child)} className="min-w-0 overflow-hidden">
                <div className="truncate font-medium text-foreground">{child.displayName}</div>
                <RepoBadgeLabel
                  name={repoFor(child)?.displayName ?? child.repoId}
                  color={repoFor(child)?.badgeColor ?? ''}
                />
                <div className="truncate text-muted-foreground">{child.path}</div>

                <DeleteWorktreeDirtyChangeHint
                  changeCount={dirtyChangeCountsByWorktreeId.get(
                    child.hostId ? getWorktreeHostIdentity(child) : child.id
                  )}
                />
              </div>
            ))}
            {descendants.length > 4 ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setExpanded(!expanded)}
              >
                {expanded
                  ? translate('worktree.delete.showFewerChildren', 'Show fewer')
                  : translate(
                      'worktree.delete.showAllChildren',
                      'Show all {{count}} child workspaces',
                      { count: descendants.length }
                    )}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
