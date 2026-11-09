// "Move to this computer": confirm what moves, show the steps with elapsed time, then the result.
// The body is a plain view (fixtures render it inline); the host wraps it in the app's Dialog.
import React from 'react'
import { Check, Circle, FolderOpen, Laptop, Loader2, Minus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { InlineError } from '@/components/ui/inline-error'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import { useNow } from '@/hooks/use-now'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { getIntlLocale } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { runOrcaCloudTransferToLocal } from '@/lib/orca-cloud-transfer-flow'
import {
  CLOUD_MOVE_STEPS,
  closeMoveToThisComputer,
  useCloudMoveState,
  type CloudMoveState,
  type CloudMoveStep
} from '@/lib/orca-cloud/orca-cloud-move-store'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { runArchiveCloudWorkspace } from './cloud-workspace-actions'

export type CloudMoveConflicts = {
  /** The cloud branch is already checked out in a local worktree: the move gets a new name. */
  branchCheckedOutLocally: string | null
}

function stepLabel(step: CloudMoveStep, t: Translate): string {
  switch (step) {
    case 'waking':
      return t('orcaCloudMove.step.waking', 'Waking')
    case 'packing':
      return t('orcaCloudMove.step.packing', 'Packing')
    case 'downloading':
      return t('orcaCloudMove.step.downloading', 'Downloading')
    case 'creating':
      return t('orcaCloudMove.step.creating', 'Creating workspace')
    case 'applying':
      return t('orcaCloudMove.step.applying', 'Applying changes')
  }
}

function formatSize(bytes: number): string {
  const mb = bytes >= 1024 * 1024
  return new Intl.NumberFormat(getIntlLocale(), {
    style: 'unit',
    unit: mb ? 'megabyte' : 'kilobyte',
    maximumFractionDigits: mb ? 1 : 0
  }).format(mb ? bytes / (1024 * 1024) : Math.max(1, Math.ceil(bytes / 1024)))
}

function MoveList({ items }: { items: React.ReactNode[] }): React.JSX.Element {
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {items.map((item, index) => (
        <li key={index} className="flex items-start gap-2">
          <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  )
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
  onClose
}: {
  state: Exclude<CloudMoveState, { stage: 'closed' }>
  conflicts: CloudMoveConflicts
  now: number
  onConfirm: () => void
  onCancel: () => void
  onOpenFolder: (dir: string) => void
  onArchiveCloud: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (state.stage === 'confirm') {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            {t('orcaCloudMove.confirm.intro', 'This creates a local workspace from {{name}}:', {
              name: state.name
            })}
          </p>
          <MoveList
            items={[
              t('orcaCloudMove.confirm.branch', 'The branch and its commits'),
              t('orcaCloudMove.confirm.changes', 'Uncommitted changes and untracked files'),
              t('orcaCloudMove.confirm.chats', 'Claude and Codex chats, so agents can resume here')
            ]}
          />
          <p className="text-xs text-muted-foreground">
            {t(
              'orcaCloudMove.confirm.counts',
              'Sizes and counts are worked out during the move. The cloud workspace stays as it is.'
            )}
          </p>
        </div>
        {conflicts.branchCheckedOutLocally ? (
          <InlineError
            tone="neutral"
            density="compact"
            title={t(
              'orcaCloudMove.confirm.branchTaken',
              '{{branch}} is already checked out on this computer',
              { branch: conflicts.branchCheckedOutLocally }
            )}
            detail={t(
              'orcaCloudMove.confirm.branchTakenDetail',
              'The moved branch gets a new name. Chats already on this computer are kept.'
            )}
          />
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {t('orcaCloudMove.cancel', 'Cancel')}
          </Button>
          <Button size="sm" onClick={onConfirm}>
            <Laptop />
            {t('orcaCloudMove.confirm.action', 'Move to this computer')}
          </Button>
        </div>
      </div>
    )
  }
  if (state.stage === 'running') {
    const current = CLOUD_MOVE_STEPS.indexOf(state.step)
    return (
      <div className="flex flex-col gap-4">
        <ol
          className="flex flex-col gap-1.5 text-sm"
          aria-label={t('orcaCloudMove.steps', 'Steps')}
        >
          {CLOUD_MOVE_STEPS.map((step, index) => {
            const skipped = state.skipped.includes(step)
            const done = !skipped && index < current
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
                ) : skipped ? (
                  <Minus className="size-3.5" aria-hidden />
                ) : (
                  <Circle className="size-3.5" aria-hidden />
                )}
                <span className={cn(skipped && 'line-through')}>{stepLabel(step, t)}</span>
                {active && step === 'downloading' && state.bytes ? (
                  <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                    {state.totalBytes
                      ? t('orcaCloudMove.bytesOf', '{{done}} of {{total}}', {
                          done: formatSize(state.bytes),
                          total: formatSize(state.totalBytes)
                        })
                      : formatSize(state.bytes)}
                  </span>
                ) : null}
              </li>
            )
          })}
        </ol>
        <p className="text-xs tabular-nums text-muted-foreground" role="status">
          {t('orcaCloudMove.elapsed', '{{elapsed}} elapsed', {
            elapsed: formatElapsedTime(now - state.startedAt)
          })}
        </p>
      </div>
    )
  }
  if (state.stage === 'failed') {
    return (
      <div className="flex flex-col gap-4">
        <InlineError
          title={t('orcaCloudMove.failed', 'Couldn’t move the workspace')}
          detail={t(
            'orcaCloudMove.failedDetail',
            'Your files are safe in the cloud workspace. Nothing was changed on this computer.'
          )}
          retryLabel={t('orcaCloudMove.retry', 'Try again')}
          onRetry={onConfirm}
        />
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('orcaCloudMove.close', 'Close')}
          </Button>
        </div>
      </div>
    )
  }
  const { finished, prepared } = state
  const chats = finished.claudeSessions + finished.codexSessions
  const items: React.ReactNode[] = [
    prepared.branch === prepared.cloudBranch || !prepared.cloudBranch
      ? t('orcaCloudMove.done.branch', 'Branch {{branch}}', { branch: prepared.branch })
      : t('orcaCloudMove.done.branchRenamed', 'Branch {{branch}} (renamed from {{cloud}})', {
          branch: prepared.branch,
          cloud: prepared.cloudBranch
        })
  ]
  if (finished.appliedStaged || finished.appliedUnstaged) {
    items.push(t('orcaCloudMove.done.changes', 'Uncommitted changes'))
  }
  if (finished.untrackedFiles > 0) {
    items.push(
      t('orcaCloudMove.done.untracked', '{{count}} untracked files', {
        count: finished.untrackedFiles,
        defaultValue_one: '{{count}} untracked file'
      })
    )
  }
  if (chats > 0) {
    items.push(
      t('orcaCloudMove.done.chats', '{{count}} agent chats', {
        count: chats,
        defaultValue_one: '{{count}} agent chat'
      })
    )
  }
  return (
    <div className="flex flex-col gap-4">
      <MoveList items={items} />
      {finished.leftoverPatchDir ? (
        <InlineError
          tone="neutral"
          density="compact"
          title={t('orcaCloudMove.partial', 'Some changes didn’t apply cleanly')}
          detail={t(
            'orcaCloudMove.partialDetail',
            'They were saved to a folder so nothing is lost. Your files are safe.'
          )}
          action={
            <Button
              size="xs"
              variant="outline"
              onClick={() => onOpenFolder(finished.leftoverPatchDir!)}
            >
              <FolderOpen />
              {t('orcaCloudMove.openFolder', 'Open folder')}
            </Button>
          }
        />
      ) : null}
      <p className="text-xs text-muted-foreground">
        {t(
          'orcaCloudMove.done.cloudKept',
          'The cloud workspace is unchanged. Archive it if you no longer need it.'
        )}
      </p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onArchiveCloud}>
          {t('orcaCloudMove.done.archive', 'Archive cloud workspace')}
        </Button>
        <Button size="sm" onClick={onClose}>
          {t('orcaCloudMove.done.close', 'Done')}
        </Button>
      </div>
    </div>
  )
}

export function cloudMoveTitle(state: CloudMoveState, t: Translate): string {
  switch (state.stage) {
    case 'running':
      return t('orcaCloudMove.title.running', 'Moving {{name}} to this computer', {
        name: state.name
      })
    case 'done':
      return t('orcaCloudMove.title.done', 'Moved to this computer')
    case 'failed':
      return t('orcaCloudMove.title.failed', 'Move didn’t finish')
    default:
      return t('orcaCloudMove.title.confirm', 'Move to this computer')
  }
}

/** Mounted once in App; renders whatever move is open. */
export function CloudMoveToComputerDialogHost({
  conflictsFor
}: {
  conflictsFor: (workspaceId: string) => CloudMoveConflicts
}): React.JSX.Element | null {
  const t = useTranslate()
  const state = useCloudMoveState()
  const now = useNow(1_000, state.stage === 'running')
  if (state.stage === 'closed') {
    return null
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          closeMoveToThisComputer()
        }
      }}
    >
      <DialogContent
        className="max-w-md"
        // A move in flight can't be dismissed mid-way; it finishes or fails on its own.
        onEscapeKeyDown={(event) => state.stage === 'running' && event.preventDefault()}
        onPointerDownOutside={(event) => state.stage === 'running' && event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{cloudMoveTitle(state, t)}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('orcaCloudMove.description', 'Copy this cloud workspace to a local workspace.')}
          </DialogDescription>
        </DialogHeader>
        <CloudMoveToComputerView
          state={state}
          conflicts={conflictsFor(state.workspaceId)}
          now={now}
          onConfirm={() => void runOrcaCloudTransferToLocal(state.workspaceId, state.name)}
          onCancel={closeMoveToThisComputer}
          onClose={closeMoveToThisComputer}
          onOpenFolder={(dir) => void window.api.shell.openPath(dir, LOCAL_EXECUTION_HOST_ID)}
          onArchiveCloud={() => {
            closeMoveToThisComputer()
            void runArchiveCloudWorkspace(state.workspaceId, { name: state.name })
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
