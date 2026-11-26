// @protected-copy
import { useId, type JSX } from 'react'
import { ScrollArea } from '@/components/ui/scroll-area'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { DeleteWorktreeDirtyChangeHint } from './DeleteWorktreeDirtyChangeHint'
import { DeleteWorktreeLocalFilesHint } from './DeleteWorktreeLocalFilesHint'
import type { DeleteWorktreeLocalFilesState } from './use-delete-worktree-at-risk-local-files'
import type {
  DeleteWorktreeChangeCheckState,
  DeleteWorktreeDirtyChangePreview
} from './delete-worktree-dirty-change-counts'
import type { AppState } from '@/store/types'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'
import { getWorktreeDeleteErrorToShow } from './worktree-delete-error-display'
import {
  getExecutionHostLabel,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { DialogDisclosure, DialogWarning } from '@/components/ui/dialog-parts'
import { deleteWorktreeLossLine } from './DeleteWorktreeChangesSummary'

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
  hostLabelById: ReadonlyMap<ExecutionHostId, string>,
  t: Translate = translate
): string {
  const hostId = parseExecutionHostId(worktree.hostId)?.id
  return hostId
    ? (hostLabelById.get(hostId) ?? getExecutionHostLabel(hostId))
    : t('components.workspace.cleanup.host.unknown', 'Unknown host')
}

export function DeleteWorktreeTargetPreview({
  isBatchDelete,
  unsavedFileCount = 0,
  worktree,
  worktrees,
  collisionWorktrees,
  hostLabelById,
  deleteStateByWorktreeId,
  dirtyChangeCountsByWorktreeId,
  dirtyChangePreviewsByWorktreeId,
  changeCheckStatesByWorktreeId,
  atRiskLocalFilesByIdentity
}: {
  isBatchDelete: boolean
  unsavedFileCount?: number
  worktree: Worktree | null
  worktrees: readonly Worktree[]
  collisionWorktrees: readonly Worktree[]
  hostLabelById: ReadonlyMap<ExecutionHostId, string>
  deleteStateByWorktreeId: AppState['deleteStateByWorktreeId']
  dirtyChangeCountsByWorktreeId: ReadonlyMap<string, number>
  dirtyChangePreviewsByWorktreeId: ReadonlyMap<string, DeleteWorktreeDirtyChangePreview>
  changeCheckStatesByWorktreeId?: ReadonlyMap<string, DeleteWorktreeChangeCheckState>
  atRiskLocalFilesByIdentity?: ReadonlyMap<string, DeleteWorktreeLocalFilesState>
}): JSX.Element | null {
  const t = useTranslate()
  const targetIdPrefix = useId()
  const collisionIds = getCollisionIds(collisionWorktrees)
  if (isBatchDelete) {
    const unknown =
      [...(changeCheckStatesByWorktreeId?.values() ?? [])].some((state) => state !== 'complete') ||
      [...(atRiskLocalFilesByIdentity?.values() ?? [])].some(
        (state) => state.status !== 'complete' || !state.files.complete
      )
    const ignored = [...(atRiskLocalFilesByIdentity?.values() ?? [])].some(
      (state) => state.status === 'complete' && state.files.count > 0
    )
    const dirtyCounts = [...dirtyChangeCountsByWorktreeId.values()]
    const loss = deleteWorktreeLossLine(
      dirtyCounts.length > 0
        ? dirtyCounts.includes(0)
          ? 0
          : dirtyCounts.reduce((total, count) => total + count, 0)
        : undefined,
      unsavedFileCount,
      t,
      ignored
    )
    return (
      <>
        {loss ? <DialogWarning>{loss}</DialogWarning> : null}
        {unknown ? (
          <p className="text-settings-detail text-muted-foreground">
            {t('worktree.delete.changesIncomplete', 'Some changes couldn’t be fully checked.')}
          </p>
        ) : null}
        <ScrollArea className="max-h-48 rounded-md border border-border/70 bg-muted/35 text-xs">
          <div className="space-y-1 px-3 py-2" role="list">
            {worktrees.map((item, index) => {
              const itemDeleteState = getDeleteStateForWorktreeHost(item, deleteStateByWorktreeId)
              const itemDeleteError = getWorktreeDeleteErrorToShow(item, itemDeleteState, t)
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
                          {getTargetHostLabel(item, hostLabelById, t)}
                        </div>
                      ) : null}
                      {itemDeleteError ? (
                        <DialogDisclosure
                          label={t('worktree.delete.errorDetails', 'Details')}
                          variant="code"
                        >
                          <p className="whitespace-pre-wrap break-all text-muted-foreground">
                            {itemDeleteError}
                          </p>
                        </DialogDisclosure>
                      ) : null}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </ScrollArea>
      </>
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
          {getTargetHostLabel(worktree, hostLabelById, t)}
        </div>
      ) : null}
      <DeleteWorktreeDirtyChangeHint
        key={getWorktreeHostIdentity(worktree)}
        checkState={changeCheckStatesByWorktreeId?.get(
          worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id
        )}
        changeCount={dirtyChangeCountsByWorktreeId.get(
          worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id
        )}
        preview={dirtyChangePreviewsByWorktreeId.get(
          worktree.hostId ? getWorktreeHostIdentity(worktree) : worktree.id
        )}
      />
      <DeleteWorktreeLocalFilesHint
        state={atRiskLocalFilesByIdentity?.get(getWorktreeHostIdentity(worktree))}
      />
    </div>
  )
}
