import { useId, type JSX } from 'react'
import { LoaderCircle } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Worktree } from '../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { DeleteWorktreeDirtyChangeHint } from './DeleteWorktreeDirtyChangeHint'
import type { AppState } from '@/store/types'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'
import {
  getExecutionHostLabel,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { getWorktreeRemovalErrorCopy } from './worktree-removal-error-copy'

function getCollisionIds(worktrees: readonly Worktree[]): ReadonlySet<string> {
  const seen = new Set<string>()
  const collisions = new Set<string>()
  for (const item of worktrees) {
    if (seen.has(item.id)) {
      collisions.add(item.id)
    } else {
      seen.add(item.id)
    }
  }
  return collisions
}

function getTargetHostLabel(
  worktree: Worktree,
  hostLabelById: ReadonlyMap<ExecutionHostId, string>
): string {
  const hostId = parseExecutionHostId(worktree.hostId)?.id
  return hostId
    ? (hostLabelById.get(hostId) ?? getExecutionHostLabel(hostId))
    : translate('components.workspace.cleanup.host.unknown', 'Unknown host')
}

export function DeleteWorktreeTargetPreview({
  isBatchDelete,
  worktree,
  worktrees,
  collisionWorktrees,
  hostLabelById,
  deleteStateByWorktreeId,
  dirtyChangeCountsByWorktreeId
}: {
  isBatchDelete: boolean
  worktree: Worktree | null
  worktrees: readonly Worktree[]
  collisionWorktrees: readonly Worktree[]
  hostLabelById: ReadonlyMap<ExecutionHostId, string>
  deleteStateByWorktreeId: AppState['deleteStateByWorktreeId']
  dirtyChangeCountsByWorktreeId: ReadonlyMap<string, number>
}): JSX.Element | null {
  const targetIdPrefix = useId()
  const collisionIds = getCollisionIds(collisionWorktrees)
  if (isBatchDelete) {
    return (
      <ScrollArea className="max-h-48 rounded-md border border-border/70 bg-muted/35 text-xs">
        <div className="space-y-1 px-3 py-2" role="list">
          {worktrees.map((item, index) => {
            const itemDeleteState = getDeleteStateForWorktreeHost(item, deleteStateByWorktreeId)
            const labelIds = {
              name: `${targetIdPrefix}-${index}-name`,
              path: `${targetIdPrefix}-${index}-path`,
              host: `${targetIdPrefix}-${index}-host`
            }
            const showHost = collisionIds.has(item.id)
            return (
              <div
                key={getWorktreeHostIdentity(item)}
                role="listitem"
                aria-labelledby={`${labelIds.name} ${labelIds.path}${showHost ? ` ${labelIds.host}` : ''}`}
                className="min-w-0 border-b border-border/50 py-1 last:border-0"
              >
                <div className="flex min-w-0 items-start gap-2">
                  <div className="min-w-0 flex-1">
                    <div id={labelIds.name} className="break-all font-medium text-foreground">
                      {item.displayName}
                    </div>
                    <div id={labelIds.path} className="mt-0.5 break-all text-muted-foreground">
                      {item.path}
                    </div>
                    {showHost ? (
                      <div id={labelIds.host} className="mt-0.5 text-muted-foreground">
                        {getTargetHostLabel(item, hostLabelById)}
                      </div>
                    ) : null}
                    <DeleteWorktreeDirtyChangeHint
                      changeCount={dirtyChangeCountsByWorktreeId.get(
                        item.hostId ? getWorktreeHostIdentity(item) : item.id
                      )}
                    />
                    {itemDeleteState?.error ? (
                      <div className="mt-1 whitespace-pre-wrap break-all text-destructive">
                        {getWorktreeRemovalErrorCopy(itemDeleteState.error)}
                      </div>
                    ) : null}
                  </div>
                  {itemDeleteState?.isDeleting ? (
                    <LoaderCircle className="mt-0.5 size-3.5 shrink-0 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
              </div>
            )
          })}
        </div>
      </ScrollArea>
    )
  }

  if (!worktree) {
    return null
  }
  const labelIds = {
    name: `${targetIdPrefix}-name`,
    path: `${targetIdPrefix}-path`,
    host: `${targetIdPrefix}-host`
  }
  const showHost = collisionIds.has(worktree.id)
  return (
    <div
      role="region"
      aria-labelledby={`${labelIds.name} ${labelIds.path}${showHost ? ` ${labelIds.host}` : ''}`}
      className="rounded-md border border-border/70 bg-muted/35 px-3 py-2 text-xs"
    >
      <div id={labelIds.name} className="break-all font-medium text-foreground">
        {worktree.displayName}
      </div>
      <div id={labelIds.path} className="mt-1 break-all text-muted-foreground">
        {worktree.path}
      </div>
      {showHost ? (
        <div id={labelIds.host} className="mt-0.5 text-muted-foreground">
          {getTargetHostLabel(worktree, hostLabelById)}
        </div>
      ) : null}
      <DeleteWorktreeDirtyChangeHint
        changeCount={dirtyChangeCountsByWorktreeId.get(
          worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id
        )}
      />
    </div>
  )
}
