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
        toast.success(translate("auto.components.shared.useDaemonActions.0e9da1b98e", "Daemon restarted."))
      } else {
        toast.error(translate("auto.components.shared.useDaemonActions.b5954e12d3", "Restart failed — check logs."))
      }
    } catch (err) {
      toast.error(translate("auto.components.shared.useDaemonActions.d762b41f41", "Restart failed."), {
        description: err instanceof Error ? err.message : undefined
      })
    } finally {
      clearPendingAction()
      if (mountedRef.current) {
        callbacks?.onRestartSettled?.()
      }
    }
  }, [callbacks, clearPendingAction, mountedRef])

  const runKillAll = useCallback(async () => {
    setBusyKind('killAll')
    callbacks?.onKillAllStart?.()
    try {
      const { killedCount, remainingCount } = await window.api.pty.management.killAll()
      if (remainingCount > 0 && killedCount > 0) {
        toast.warning(
          translate("auto.components.shared.useDaemonActions.fe2ab66d45", "Killed {{value0}} of {{value1}} sessions. {{value2}} refused to exit.", { value0: killedCount, value1: killedCount + remainingCount, value2: remainingCount })
        )
      } else if (killedCount > 0) {
        toast.success(translate("auto.components.shared.useDaemonActions.fe2ab66d45", "Killed {{value0}} session{{value1}}.", { value0: killedCount, value1: killedCount === 1 ? '' : 's' }))
      } else if (remainingCount === 0) {
        toast.info(translate("auto.components.shared.useDaemonActions.baad8cd651", "No sessions running."))
      } else {
        toast.error(translate("auto.components.shared.useDaemonActions.d18f3005c2", "{{value0}} session{{value1}} refused to exit.", { value0: remainingCount, value1: remainingCount === 1 ? '' : 's' }))
      }
    } catch (err) {
      if (mountedRef.current) {
        callbacks?.onKillAllError?.()
      }
      toast.error(translate("auto.components.shared.useDaemonActions.2b4efdc162", "Couldn’t kill sessions."), {
        description: err instanceof Error ? err.message : undefined
      })
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
      title: translate("auto.components.shared.useDaemonActions.922548bc66", "Restart the terminal daemon?"),
      description: (
        <>
          {translate("auto.components.shared.useDaemonActions.01d6b7c64e", "Kills every running terminal pane and restarts the daemon process. Panes show \"Process exited\" and can be reopened immediately. Legacy-protocol sessions from a previous app version are preserved. This can't be undone.")}</>
      ),
      confirmLabel: 'Restart daemon',
      busyLabel: 'Restarting…'
    }
  }
  return {
    title: translate("auto.components.shared.useDaemonActions.1bbea41a77", "Kill all terminal sessions?"),
    description: (
      <>
        {translate("auto.components.shared.useDaemonActions.28c8e53176", "This force-quits every running terminal pane across all workspaces. Any unsaved work in those sessions is lost. The daemon itself keeps running, and new terminals can be opened immediately. This can't be undone.")}</>
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
                {translate("auto.components.shared.useDaemonActions.01af244097", "Cancel")}</Button>
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
