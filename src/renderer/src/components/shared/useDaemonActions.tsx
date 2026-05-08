import React, { useCallback, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

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

export function useDaemonActions(callbacks?: DaemonActionCallbacks): DaemonActionsApi {
  const [pending, setPending] = useState<PendingConfirm>(null)
  const [busyKind, setBusyKind] = useState<DaemonActionKind | null>(null)

  const runRestart = useCallback(async () => {
    setBusyKind('restart')
    try {
      const { success } = await window.api.pty.management.restart()
      if (success) {
        toast.success('Daemon restarted.')
      } else {
        toast.error('Restart failed — check logs.')
      }
    } catch (err) {
      toast.error('Restart failed.', {
        description: err instanceof Error ? err.message : undefined
      })
    } finally {
      setBusyKind(null)
      setPending(null)
      callbacks?.onRestartSettled?.()
    }
  }, [callbacks])

  const runKillAll = useCallback(async () => {
    setBusyKind('killAll')
    callbacks?.onKillAllStart?.()
    try {
      const { killedCount, remainingCount } = await window.api.pty.management.killAll()
      if (remainingCount > 0 && killedCount > 0) {
        toast.warning(
          `Killed ${killedCount} of ${killedCount + remainingCount} sessions. ${remainingCount} refused to exit.`
        )
      } else if (killedCount > 0) {
        toast.success(`Killed ${killedCount} session${killedCount === 1 ? '' : 's'}.`)
      } else if (remainingCount === 0) {
        toast.info('No sessions running.')
      } else {
        toast.error(`${remainingCount} session${remainingCount === 1 ? '' : 's'} refused to exit.`)
      }
    } catch (err) {
      callbacks?.onKillAllError?.()
      toast.error('Couldn’t kill sessions.', {
        description: err instanceof Error ? err.message : undefined
      })
    } finally {
      setBusyKind(null)
      setPending(null)
      callbacks?.onKillAllSettled?.()
    }
  }, [callbacks])

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
      title: 'Restart the terminal daemon?',
      description: (
        <>
          Kills every running terminal pane and restarts the daemon process. Panes show
          &ldquo;Process exited&rdquo; and can be reopened immediately. Legacy-protocol sessions
          from a previous app version are preserved. This can&apos;t be undone.
        </>
      ),
      confirmLabel: 'Restart daemon',
      busyLabel: 'Restarting…'
    }
  }
  return {
    title: 'Kill all terminal sessions?',
    description: (
      <>
        This force-quits every running terminal pane across all workspaces. Any unsaved work in
        those sessions is lost. The daemon itself keeps running, and new terminals can be opened
        immediately. This can&apos;t be undone.
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
                Cancel
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
