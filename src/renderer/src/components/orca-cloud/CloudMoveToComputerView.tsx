// "Move to this computer" progress card body: the steps with elapsed time, then a failure or a
// partial result (a full result is the background-create toast). The confirm is its own dialog.
import React from 'react'
import { Check, Circle, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import { useTranslate } from '@/i18n/use-translate'
import { useArchiveTtlDays } from '@/lib/orca-cloud/archive-ttl'
import { cn } from '@/lib/class-names'
import { CLOUD_MOVE_STEPS, type CloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'
import { DEFAULT_ARCHIVE_TTL_DAYS } from './archive-snapshot-copy'
import { cloudMoveStepLabel, formatMoveSize } from './cloud-move-copy'
import { CloudMovePartialResult } from './cloud-move-parts'
import { CloudMoveFailedBody } from './CloudMoveFailedBody'

export type CloudMoveConflicts = {
  /** The cloud branch is already checked out here: the move gets this new name instead. */
  branchCheckedOutLocally: { branch: string } | null
}

type CardState = Extract<CloudMoveState, { stage: 'running' | 'done' | 'failed' }>

/** The card's body for one state. Pure: actions come in as callbacks. */
export function CloudMoveToComputerView({
  state,
  now,
  onConfirm,
  onOpenFolder,
  onOpenLocal,
  onClose,
  onCancelMove,
  onReapply
}: {
  state: CardState
  now: number
  /** Retry after a failure. */
  onConfirm: () => void
  onOpenFolder: (dir: string) => void
  onOpenLocal: (worktreeId: string) => void
  onClose: () => void
  /** Cancel on a running move: stops it and removes what it left here. */
  onCancelMove: () => void
  /** "Apply changes again" on the same local worktree (failed apply, or partial result). */
  onReapply?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const archiveTtl = useArchiveTtlDays() ?? DEFAULT_ARCHIVE_TTL_DAYS

  if (state.stage === 'running') {
    const current = CLOUD_MOVE_STEPS.indexOf(state.step)
    const progress =
      state.step === 'downloading' && state.bytes
        ? state.totalBytes
          ? t('orcaCloudMove.bytesOf', '{{done}} of {{total}}', {
              done: formatMoveSize(state.bytes),
              total: formatMoveSize(state.totalBytes)
            })
          : formatMoveSize(state.bytes)
        : null
    return (
      <div className="flex flex-col gap-4">
        <ol
          className="flex flex-col gap-1.5 text-sm"
          aria-label={t('orcaCloudMove.steps', 'Steps')}
        >
          {CLOUD_MOVE_STEPS.filter((step) => !state.skipped.includes(step)).map((step) => {
            const index = CLOUD_MOVE_STEPS.indexOf(step)
            const done = index < current
            const active = index === current
            return (
              <li
                key={step}
                className={cn(
                  'flex items-center gap-2',
                  !active && !done && 'text-muted-foreground'
                )}
                aria-current={active ? 'step' : undefined}
              >
                {active ? (
                  <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden />
                ) : done ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <Circle className="size-3.5" aria-hidden />
                )}
                <span>{cloudMoveStepLabel(step, t)}</span>
                <span className="sr-only">
                  {active
                    ? t('orcaCloudMove.stepState.active', 'in progress')
                    : done
                      ? t('orcaCloudMove.stepState.done', 'done')
                      : t('orcaCloudMove.stepState.pending', 'not started')}
                </span>
                {active && progress ? (
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground" aria-hidden>
                    {progress}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ol>
        {/* Announces step changes only; byte progress and time are visual (no chatter per chunk). */}
        <p className="sr-only" role="status">
          {cloudMoveStepLabel(state.step, t)}
        </p>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs tabular-nums text-muted-foreground" aria-hidden>
            {t('orcaCloudMove.elapsed', '{{elapsed}} elapsed', {
              elapsed: formatElapsedTime(now - state.startedAt)
            })}
          </p>
          {state.cancel === 'available' ? (
            <Button variant="ghost" size="xs" onClick={onCancelMove}>
              {t('orcaCloudMove.cancel', 'Cancel')}
            </Button>
          ) : state.cancel === 'cancelling' ? (
            <Button variant="ghost" size="xs" aria-disabled aria-busy>
              <Loader2 className="motion-safe:animate-spin" aria-hidden />
              {t('orcaCloudMove.cancelling', 'Cancelling…')}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  if (state.stage === 'failed') {
    return (
      <CloudMoveFailedBody
        state={state}
        onConfirm={onConfirm}
        onClose={onClose}
        onOpenLocal={onOpenLocal}
        onReapply={onReapply}
      />
    )
  }

  const { finished, prepared } = state
  const partial = finished.leftoverPatchDir
  return (
    <div className="flex flex-col gap-4">
      <p className="flex items-start gap-2 text-sm">
        <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {t('orcaCloudMove.done.branch', 'Branch {{branch}}', { branch: prepared.branch })}
      </p>
      {partial ? (
        <CloudMovePartialResult
          folder={partial}
          conflicts={finished.conflicts ?? []}
          notWritten={finished.skippedUntracked ?? []}
          onOpenFolder={onOpenFolder}
          onReapply={onReapply}
        />
      ) : null}
      {finished.notMoved && finished.notMoved.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t('orcaCloudMove.done.notMoved', 'Left in the cloud (links aren’t moved): {{files}}', {
            files: finished.notMoved.slice(0, 5).join(', ')
          })}
        </p>
      ) : null}
      {state.archivedAfter ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'orcaCloudMove.done.archivedShort',
            'Cloud copy archived; deleted in {{count}} days.',
            {
              count: archiveTtl,
              defaultValue_one: 'Cloud copy archived; deleted in {{count}} day.'
            }
          )}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button
          size="sm"
          onClick={() => {
            onOpenLocal(state.localWorktreeId)
            onClose()
          }}
        >
          {t('orcaCloudMove.openHere', 'Open here')}
        </Button>
      </div>
    </div>
  )
}
