// "Move to this computer" body: confirm what moves, the steps with elapsed time, then the result.
// A plain view (fixtures render it inline); CloudMoveToComputerDialog wraps it in the app's Dialog.
import React, { useEffect, useRef } from 'react'
import { AlertTriangle, Check, Circle, FolderOpen, Laptop, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { InlineError } from '@/components/ui/inline-error'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { CLOUD_MOVE_STEPS, type CloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'
import { cloudMoveStepLabel, formatMoveSize } from './cloud-move-copy'

export { cloudMoveStepLabel, cloudMoveTitle } from './cloud-move-copy'

export type CloudMoveConflicts = {
  /** The cloud branch is already checked out here: the move gets this new name instead. */
  branchCheckedOutLocally: { branch: string; newName: string } | null
}

type OpenState = Exclude<CloudMoveState, { stage: 'closed' }>

/** Neutral bullets for what will move (not checkmarks: nothing has happened yet). */
function BulletList({ items }: { items: React.ReactNode[] }): React.JSX.Element {
  return (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-sm marker:text-muted-foreground">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  )
}

/** Moves focus to the stage's main control whenever the stage changes. */
function useFocusOnStage(
  stage: OpenState['stage'],
  ref: React.RefObject<HTMLElement | null>
): void {
  useEffect(() => {
    ref.current?.focus()
  }, [stage, ref])
}

/** The dialog's body for one state. Pure: actions come in as callbacks. */
export function CloudMoveToComputerView({
  state,
  conflicts,
  now,
  onConfirm,
  onCancel,
  onOpenFolder,
  onArchiveCloud,
  onOpenLocal,
  onClose,
  onArchiveAfterChange,
  onHide
}: {
  state: OpenState
  conflicts: CloudMoveConflicts
  now: number
  onConfirm: () => void
  onCancel: () => void
  onOpenFolder: (dir: string) => void
  onArchiveCloud: () => void
  onOpenLocal: (worktreeId: string) => void
  onClose: () => void
  onArchiveAfterChange: (archiveAfter: boolean) => void
  onHide: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const primary = useRef<HTMLButtonElement | null>(null)
  useFocusOnStage(state.stage, primary)

  if (state.stage === 'confirm') {
    const known = state.known
    const taken = conflicts.branchCheckedOutLocally
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted-foreground">
          {t('orcaCloudMove.confirm.intro', 'This creates a local workspace from {{name}}:', {
            name: state.name
          })}
        </p>
        <BulletList
          items={[
            known?.branch
              ? t('orcaCloudMove.confirm.branchNamed', 'Branch {{branch}} and its commits', {
                  branch: known.branch
                })
              : t('orcaCloudMove.confirm.branch', 'The branch and its commits'),
            known
              ? t(
                  'orcaCloudMove.confirm.changesCount',
                  '{{count}} uncommitted changes, plus untracked files',
                  {
                    count: known.uncommittedChanges,
                    defaultValue_one: '{{count}} uncommitted change, plus untracked files'
                  }
                )
              : t('orcaCloudMove.confirm.changes', 'Uncommitted changes and untracked files'),
            known && known.chats > 0
              ? t(
                  'orcaCloudMove.confirm.chatsCount',
                  '{{count}} agent chats, so agents can resume here',
                  {
                    count: known.chats,
                    defaultValue_one: '{{count}} agent chat, so the agent can resume here'
                  }
                )
              : t(
                  'orcaCloudMove.confirm.chats',
                  'Claude and Codex chats, so agents can resume here'
                )
          ]}
        />
        {taken ? (
          <InlineError
            tone="neutral"
            density="compact"
            title={t(
              'orcaCloudMove.confirm.branchTaken',
              '{{branch}} is already checked out on this computer',
              {
                branch: taken.branch
              }
            )}
            detail={t(
              'orcaCloudMove.confirm.branchTakenDetail',
              'It will be {{newName}}. Chats already on this computer are kept.',
              { newName: taken.newName }
            )}
          />
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={state.archiveAfter}
            onCheckedChange={(checked) => onArchiveAfterChange(checked === true)}
          />
          {t('orcaCloudMove.confirm.archiveAfter', 'Archive the cloud workspace afterwards')}
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('orcaCloudMove.cancel', 'Cancel')}
          </Button>
          <Button ref={primary} size="sm" onClick={onConfirm}>
            <Laptop />
            {t('orcaCloudMove.confirm.action', 'Move to this computer')}
          </Button>
        </div>
      </div>
    )
  }

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
        {/* One announcement per step change; the ticking time is visual only. */}
        <p className="sr-only" role="status">
          {progress
            ? t('orcaCloudMove.announce.withProgress', '{{step}}, {{progress}}', {
                step: cloudMoveStepLabel(state.step, t),
                progress
              })
            : cloudMoveStepLabel(state.step, t)}
        </p>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <p className="text-xs text-muted-foreground">
              {t(
                'orcaCloudMove.background',
                'You can keep working; this finishes in the background.'
              )}
            </p>
            <p className="text-xs tabular-nums text-muted-foreground" aria-hidden>
              {t('orcaCloudMove.elapsed', '{{elapsed}} elapsed', {
                elapsed: formatElapsedTime(now - state.startedAt)
              })}
            </p>
          </div>
          <Button ref={primary} variant="ghost" size="sm" onClick={onHide}>
            {t('orcaCloudMove.hide', 'Hide')}
          </Button>
        </div>
      </div>
    )
  }

  if (state.stage === 'failed') {
    const localStarted = state.step === 'creating' || state.step === 'applying'
    return (
      <div className="flex flex-col gap-4">
        <InlineError
          title={
            state.timedOut
              ? t(
                  'orcaCloudMove.cause.timedOut',
                  'It took too long while {{step}}, so Orca stopped it.',
                  {
                    step: cloudMoveStepLabel(state.step, t).toLowerCase()
                  }
                )
              : t('orcaCloudMove.cause.step', 'Something went wrong while {{step}}.', {
                  step: cloudMoveStepLabel(state.step, t).toLowerCase()
                })
          }
          detail={
            localStarted
              ? t(
                  'orcaCloudMove.failedLocalDetail',
                  'The local workspace was created, but the changes didn’t apply. Your files are safe in the cloud workspace.'
                )
              : t(
                  'orcaCloudMove.failedDetail',
                  'Your files are safe in the cloud workspace. Nothing changed on this computer.'
                )
          }
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('orcaCloudMove.close', 'Close')}
          </Button>
          <Button ref={primary} size="sm" onClick={onConfirm}>
            {t('orcaCloudMove.retry', 'Try again')}
          </Button>
        </div>
      </div>
    )
  }

  const { finished, prepared } = state
  const chats = finished.claudeSessions + finished.codexSessions
  const partial = finished.leftoverPatchDir
  const rows: { text: React.ReactNode; warn?: boolean }[] = [
    {
      text:
        prepared.branch === prepared.cloudBranch || !prepared.cloudBranch
          ? t('orcaCloudMove.done.branch', 'Branch {{branch}}', { branch: prepared.branch })
          : t('orcaCloudMove.done.branchRenamed', 'Branch {{branch}} (renamed from {{cloud}})', {
              branch: prepared.branch,
              cloud: prepared.cloudBranch
            })
    }
  ]
  if (partial || finished.appliedStaged || finished.appliedUnstaged) {
    rows.push({
      text: partial
        ? t('orcaCloudMove.done.changesPartial', 'Uncommitted changes, partly')
        : t('orcaCloudMove.done.changes', 'Uncommitted changes'),
      warn: Boolean(partial)
    })
  }
  if (finished.untrackedFiles > 0) {
    rows.push({
      text: t('orcaCloudMove.done.untracked', '{{count}} untracked files', {
        count: finished.untrackedFiles,
        defaultValue_one: '{{count}} untracked file'
      })
    })
  }
  if (chats > 0) {
    rows.push({
      text: t('orcaCloudMove.done.chats', '{{count}} agent chats', {
        count: chats,
        defaultValue_one: '{{count}} agent chat'
      })
    })
  }
  return (
    <div className="flex flex-col gap-4">
      <ul className="flex flex-col gap-1 text-sm">
        {rows.map((row, index) => (
          <li key={index} className="flex items-start gap-2">
            {row.warn ? (
              <AlertTriangle
                className="mt-0.5 size-3.5 shrink-0 text-status-warning-text"
                aria-hidden
              />
            ) : (
              <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span>{row.text}</span>
          </li>
        ))}
      </ul>
      {partial ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-3">
          <p className="text-sm">
            {t(
              'orcaCloudMove.partialDetail',
              'Some changes didn’t apply cleanly. They were saved here, so nothing is lost:'
            )}
          </p>
          <Button
            ref={primary}
            size="xs"
            variant="outline"
            className="max-w-full justify-start self-start"
            onClick={() => onOpenFolder(partial)}
          >
            <FolderOpen />
            <span className="truncate">
              {t('orcaCloudMove.openFolderAt', 'Open {{dir}}', { dir: partial })}
            </span>
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {state.archivedAfter
          ? t(
              'orcaCloudMove.done.archived',
              'The cloud workspace is archived. Unarchive it any time.'
            )
          : t(
              'orcaCloudMove.done.stillRunning',
              'The cloud workspace is still running and using sandbox hours. Archive it to stop that; you can unarchive later.'
            )}
      </p>
      <div className="flex justify-end gap-2">
        {state.archivedAfter ? null : (
          <Button variant="outline" size="sm" onClick={onArchiveCloud}>
            {t('orcaCloudMove.done.archive', 'Archive cloud workspace')}
          </Button>
        )}
        <Button
          ref={partial ? undefined : primary}
          size="sm"
          onClick={() => {
            onOpenLocal(state.localWorktreeId)
            onClose()
          }}
        >
          {t('orcaCloudMove.done.open', 'Open workspace')}
        </Button>
      </div>
    </div>
  )
}
