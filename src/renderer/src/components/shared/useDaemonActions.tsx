import React, { useCallback, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
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
import { translate } from '@/i18n/i18n'
import {
  runKillAllTerminalSurfaces,
  snapshotKillAllTerminalSurfaceIds,
  type KillAllTerminalSurfacesSummary
} from './kill-all-terminal-surfaces'

export type DaemonActionKind = 'restart' | 'killAll'

export type DaemonActionCallbacks = {
  // Why: ManageSessionsSection owns an optimistic setSessions([]) + rollback
  // pattern. Exposing lifecycle hooks lets each caller keep the state that
  // belongs to it (the settings pane's list; the status bar's badge) instead
  // of pulling unrelated concerns into this module.
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
  const description = [surfaceDescription, daemonDescription].filter(Boolean).join(' ')
  if (summary.daemon.status === 'rejected') {
    toast.error(
      translate(
        'auto.components.shared.useDaemonActions.1f0d8ac762',
        'Terminal cleanup finished with errors.'
      ),
      { description }
    )
    return
  }
  if (summary.failedCloseAttemptCount > 0 || summary.exactKillRejectedCount > 0) {
    toast.error(
      translate(
        'auto.components.shared.useDaemonActions.1f0d8ac762',
        'Terminal cleanup finished with errors.'
      ),
      { description }
    )
    return
  }
  if (summary.daemon.remainingCount > 0) {
    toast.warning(
      translate(
        'auto.components.shared.useDaemonActions.80b6ea14cf',
        'Terminal cleanup finished with warnings.'
      ),
      { description }
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
    { description }
  )
}

export function useDaemonActions(callbacks?: DaemonActionCallbacks): DaemonActionsApi {
  const [pending, setPending] = useState<PendingConfirm>(null)
  const [busyKind, setBusyKind] = useState<DaemonActionKind | null>(null)
  const mountedRef = useMountedRef()

  const clearPendingAction = useCallback((): void => {
    if (!mountedRef.current) {
      return
    }
    setBusyKind(null)
    setPending(null)
  }, [mountedRef])

  const runRestart = useCallback(async () => {
    setBusyKind('restart')
    try {
      const { success } = await window.api.pty.management.restart()
      if (success) {
        toast.success(
          translate('auto.components.shared.useDaemonActions.0e9da1b98e', 'Daemon restarted.')
        )
      } else {
        toast.error(
          translate(
            'auto.components.shared.useDaemonActions.b5954e12d3',
            'Restart failed — check logs.'
          )
        )
      }
    } catch (err) {
      toast.error(
        translate('auto.components.shared.useDaemonActions.d762b41f41', 'Restart failed.'),
        {
          description: err instanceof Error ? err.message : undefined
        }
      )
    } finally {
      clearPendingAction()
      if (mountedRef.current) {
        callbacks?.onRestartSettled?.()
      }
    }
  }, [callbacks, clearPendingAction, mountedRef])

  const runKillAll = useCallback(async () => {
    // Why: confirmation covers the surface identities visible now; taking this
    // before callbacks or awaits keeps later-created terminal tabs out of scope.
    const targetSurfaceIds = snapshotKillAllTerminalSurfaceIds()
    setBusyKind('killAll')
    callbacks?.onKillAllStart?.()
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
      toast.error(
        translate(
          'auto.components.shared.useDaemonActions.e8f25bd903',
          'Couldn’t finish terminal cleanup.'
        ),
        {
          description: err instanceof Error ? err.message : undefined
        }
      )
    } finally {
      clearPendingAction()
      if (mountedRef.current) {
        callbacks?.onKillAllSettled?.()
      }
    }
  }, [callbacks, clearPendingAction, mountedRef])

  const runConfirmed = useCallback(() => {
    if (pending === 'restart') {
      void runRestart()
    } else if (pending === 'killAll') {
      void runKillAll()
    }
  }, [pending, runRestart, runKillAll])

  return {
    pending,
    setPending,
    busyKind,
    isBusy: busyKind !== null,
    runRestart,
    runKillAll,
    runConfirmed
  }
}

type CopyShape = {
  title: string
  description: React.ReactNode
  confirmLabel: string
  busyLabel: string
}

function getCopy(kind: DaemonActionKind): CopyShape {
  if (kind === 'restart') {
    return {
      title: translate(
        'auto.components.shared.useDaemonActions.922548bc66',
        'Restart the terminal daemon?'
      ),
      description: (
        <>
          {translate(
            'auto.components.shared.useDaemonActions.01d6b7c64e',
            'Kills every running terminal pane and restarts the daemon process. Panes show "Process exited" and can be reopened immediately. Legacy-protocol sessions from a previous app version are preserved. This can\'t be undone.'
          )}
        </>
      ),
      confirmLabel: 'Restart daemon',
      busyLabel: 'Restarting…'
    }
  }
  return {
    title: translate(
      'auto.components.shared.useDaemonActions.1bbea41a77',
      'Kill all terminal sessions?'
    ),
    description: (
      <>
        {translate(
          'auto.components.shared.useDaemonActions.a702d4196e',
          "This closes every terminal tab across all workspaces and requests shutdown for its current terminal sessions. Any unsaved terminal work is lost. The daemon itself keeps running, and new terminals can be opened immediately. This can't be undone."
        )}
      </>
    ),
    confirmLabel: 'Kill all sessions',
    busyLabel: 'Killing…'
  }
}

export function DaemonActionDialog({
  api,
  // Why: when mounted under a Popover, we need the confirm to stay open while
  // the mutation runs. The caller wires `onOpenChange` here to gate dismissal.
  extraDescription
}: {
  api: DaemonActionsApi
  extraDescription?: React.ReactNode
}): React.JSX.Element {
  const { pending, setPending, busyKind, isBusy, runConfirmed } = api
  const copy = pending ? getCopy(pending) : null
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (open) {
          return
        }
        if (isBusy) {
          return
        }
        setPending(null)
      }}
    >
      <DialogContent
        className="max-w-md"
        showCloseButton={!isBusy}
        onPointerDownOutside={(e) => {
          if (isBusy) {
            e.preventDefault()
          }
        }}
        onEscapeKeyDown={(e) => {
          if (isBusy) {
            e.preventDefault()
          }
        }}
      >
        {copy ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-sm">{copy.title}</DialogTitle>
              <DialogDescription className="text-xs">
                {copy.description}
                {extraDescription ? <div className="mt-2">{extraDescription}</div> : null}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPending(null)} disabled={isBusy}>
                {translate('auto.components.shared.useDaemonActions.01af244097', 'Cancel')}
              </Button>
              <Button variant="destructive" onClick={runConfirmed} disabled={isBusy}>
                {isBusy ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {isBusy && busyKind === pending ? copy.busyLabel : copy.confirmLabel}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
