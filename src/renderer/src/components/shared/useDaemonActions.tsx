import React, { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { DialogCancel, DialogError } from '../ui/dialog-parts'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  runKillAllTerminalSurfaces,
  snapshotKillAllTerminalSurfaceIds,
  type KillAllTerminalSurfacesSummary
} from './kill-all-terminal-surfaces'

export type DaemonActionKind = 'restart' | 'killAll'

export type DaemonActionCallbacks = {
  // Keep optimistic list/badge ownership with callers by exposing mutation lifecycle callbacks.
  onKillAllStart?: () => void
  onKillAllError?: () => void
  onKillAllSettled?: () => void
  onRestartSettled?: () => void
}

type PendingConfirm = DaemonActionKind | null

export type DaemonActionsApi = {
  pending: PendingConfirm
  setPending: (kind: PendingConfirm) => void
  busyKind: DaemonActionKind | null
  isBusy: boolean
  /** The confirmed action failed outright; the dialog stays open to offer Try again. */
  error: string | null
  runRestart: () => Promise<void>
  runKillAll: () => Promise<void>
  runConfirmed: () => void
}

function showKillAllTerminalSurfacesResult(summary: KillAllTerminalSurfacesSummary): void {
  const surfaceDescription =
    summary.targetCount > 0
      ? translate(
          'auto.components.shared.useDaemonActions.71a8d342b0',
          'Terminal tabs absent: {{value0}}/{{value1}}. Failed close attempts: {{value2}}. Exact PTY shutdown requests accepted: {{value3}}; failed: {{value4}}.',
          {
            value0: summary.absentTargetCount,
            value1: summary.targetCount,
            value2: summary.failedCloseAttemptCount,
            value3: summary.exactKillAcceptedCount,
            value4: summary.exactKillRejectedCount
          }
        )
      : null
  const daemonDescription =
    summary.daemon.status === 'rejected'
      ? translate(
          'auto.components.shared.useDaemonActions.2e57c1a940',
          'The daemon shutdown result is unverified because its management request failed.'
        )
      : translate(
          'auto.components.shared.useDaemonActions.993af6052c',
          'Daemon management reported exited: {{value0}}/{{value1}}; still present before exact cleanup: {{value2}}.',
          {
            value0: summary.daemon.killedCount,
            value1: summary.daemon.killedCount + summary.daemon.remainingCount,
            value2: summary.daemon.remainingCount
          }
        )
  const inventoryWarning =
    summary.daemon.status === 'fulfilled' && summary.daemon.listingIncomplete
      ? translate(
          'components.shared.useDaemonActions.someSessionsUnchecked',
          'Some sessions couldn’t be checked.'
        )
      : null
  const description = [
    [surfaceDescription, daemonDescription].filter(Boolean).join(' '),
    inventoryWarning
  ]
    .filter(Boolean)
    .join('\n')
  const noticeOptions = inventoryWarning
    ? { description, classNames: { description: 'whitespace-pre-line' } }
    : { description }
  if (summary.daemon.status === 'rejected') {
    toast.error(
      translate(
        'auto.components.shared.useDaemonActions.1f0d8ac762',
        'Terminal cleanup finished with errors.'
      ),
      noticeOptions
    )
    return
  }
  if (summary.failedCloseAttemptCount > 0 || summary.exactKillRejectedCount > 0) {
    toast.error(
      translate(
        'auto.components.shared.useDaemonActions.1f0d8ac762',
        'Terminal cleanup finished with errors.'
      ),
      noticeOptions
    )
    return
  }
  if (summary.daemon.remainingCount > 0 || summary.daemon.listingIncomplete) {
    toast.warning(
      translate(
        'auto.components.shared.useDaemonActions.80b6ea14cf',
        'Terminal cleanup finished with warnings.'
      ),
      noticeOptions
    )
    return
  }
  if (summary.targetCount === 0 && summary.daemon.killedCount === 0) {
    toast.info(
      translate(
        'auto.components.shared.useDaemonActions.47cd2a50e9',
        'No sessions or terminal tabs were reported.'
      )
    )
    return
  }
  toast.success(
    summary.targetCount > 0
      ? translate(
          'auto.components.shared.useDaemonActions.c34fb1098d',
          'Terminal tabs closed and shutdown requested.'
        )
      : translate(
          'auto.components.shared.useDaemonActions.d9657ac204',
          'Terminal session shutdown requested.'
        ),
    noticeOptions
  )
}

export function useDaemonActions(callbacks?: DaemonActionCallbacks): DaemonActionsApi {
  const [pending, setPending] = useState<PendingConfirm>(null)
  const [busyKind, setBusyKind] = useState<DaemonActionKind | null>(null)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useMountedRef()

  const changePending = useCallback((kind: PendingConfirm): void => {
    setError(null)
    setPending(kind)
  }, [])

  // Why keep it open on failure: nothing ran, so the same confirmation can retry in place.
  const settlePendingAction = useCallback(
    (failure: string | null): void => {
      if (!mountedRef.current) {
        return
      }
      setBusyKind(null)
      setError(failure)
      if (failure === null) {
        setPending(null)
      }
    },
    [mountedRef]
  )

  const runRestart = useCallback(async () => {
    setBusyKind('restart')
    setError(null)
    const failure = translate(
      'components.shared.useDaemonActions.restartFailed',
      'Couldn’t restart the terminal service.'
    )
    let outcome: string | null = failure
    try {
      const { success } = await window.api.pty.management.restart()
      if (success) {
        outcome = null
        toast.success(
          translate('auto.components.shared.useDaemonActions.0e9da1b98e', 'Daemon restarted.')
        )
      }
    } catch (err) {
      console.error('[terminal-service] restart failed:', err)
    } finally {
      settlePendingAction(outcome)
      if (mountedRef.current) {
        callbacks?.onRestartSettled?.()
      }
    }
  }, [callbacks, settlePendingAction, mountedRef])

  const runKillAll = useCallback(async () => {
    // Snapshot confirmed surfaces before callbacks/awaits so newly created tabs stay outside the destructive scope.
    const targetSurfaceIds = snapshotKillAllTerminalSurfaceIds()
    setBusyKind('killAll')
    setError(null)
    callbacks?.onKillAllStart?.()
    let outcome: string | null = null
    try {
      const summary = await runKillAllTerminalSurfaces(targetSurfaceIds)
      if (summary.daemon.status === 'rejected' && mountedRef.current) {
        callbacks?.onKillAllError?.()
      }
      showKillAllTerminalSurfacesResult(summary)
    } catch (err) {
      if (mountedRef.current) {
        callbacks?.onKillAllError?.()
      }
      console.error('[terminal-service] kill all sessions failed:', err)
      outcome = translate(
        'auto.components.shared.useDaemonActions.e8f25bd903',
        'Couldn’t finish terminal cleanup.'
      )
    } finally {
      settlePendingAction(outcome)
      if (mountedRef.current) {
        callbacks?.onKillAllSettled?.()
      }
    }
  }, [callbacks, settlePendingAction, mountedRef])

  const runConfirmed = useCallback(() => {
    if (pending === 'restart') {
      void runRestart()
    } else if (pending === 'killAll') {
      void runKillAll()
    }
  }, [pending, runRestart, runKillAll])

  return {
    pending,
    setPending: changePending,
    busyKind,
    isBusy: busyKind !== null,
    error,
    runRestart,
    runKillAll,
    runConfirmed
  }
}

type DaemonActionCopy = {
  title: string
  description: string
  confirmLabel: string
  busyLabel: string
}

function getCopy(kind: DaemonActionKind, t: Translate = translate): DaemonActionCopy {
  if (kind === 'restart') {
    return {
      title: t(
        'auto.components.shared.useDaemonActions.922548bc66',
        'Restart the terminal service?'
      ),
      description: t(
        'auto.components.shared.useDaemonActions.01d6b7c64e',
        'Open terminals and agents will restart. Terminals on remote hosts are not affected.'
      ),
      confirmLabel: t('auto.components.shared.useDaemonActions.confirmRestart', 'Restart'),
      busyLabel: t('auto.components.shared.useDaemonActions.busyRestarting', 'Restarting…')
    }
  }
  return {
    title: t('auto.components.shared.useDaemonActions.1bbea41a77', 'Kill all terminal sessions?'),
    description: t(
      'components.shared.useDaemonActions.killAllSessionsDescription',
      'Ends every terminal session and its agents, including ones with no open tab. Unsaved work is lost.'
    ),
    confirmLabel: t('auto.components.shared.useDaemonActions.confirmKillAll', 'Kill all sessions'),
    busyLabel: t('auto.components.shared.useDaemonActions.busyKilling', 'Killing…')
  }
}

export function DaemonActionDialog({ api }: { api: DaemonActionsApi }): React.JSX.Element {
  const t = useTranslate()
  const { pending, setPending, busyKind, isBusy, error, runConfirmed } = api
  const copy = pending ? getCopy(pending, t) : null
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open && !isBusy) {
          setPending(null)
        }
      }}
    >
      <DialogContent
        size="confirm"
        busy={isBusy}
        initialFocus="cancel"
        className="z-[80]"
        overlayClassName="z-[80]"
      >
        {copy ? (
          <>
            <DialogHeader>
              <DialogTitle>{copy.title}</DialogTitle>
              <DialogDescription>{copy.description}</DialogDescription>
            </DialogHeader>
            {error ? <DialogError>{error}</DialogError> : null}
            <DialogFooter>
              <DialogCancel>
                {t('auto.components.shared.useDaemonActions.01af244097', 'Cancel')}
              </DialogCancel>
              <Button size="sm" variant="destructive" onClick={runConfirmed} disabled={isBusy}>
                {isBusy && busyKind === pending ? copy.busyLabel : copy.confirmLabel}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
