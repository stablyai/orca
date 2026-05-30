import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import { useMountedRef } from '@/hooks/useMountedRef'
import { SshDestructiveActionDialog } from './SshDestructiveActionDialog'
import { isSshTargetConnecting, type SshTargetBusyAction } from './ssh-target-action-state'

type PendingTargetAction = { id: string; label: string }

type SshTargetDestructiveActionsRenderProps = {
  busyActionForTarget: (targetId: string) => SshTargetBusyAction | undefined
  requestRemove: (target: PendingTargetAction) => void
  requestResetRelay: (target: PendingTargetAction) => void
  requestTerminateSessions: (target: PendingTargetAction) => void
}

type SshTargetDestructiveActionsProps = {
  connectionStates: Map<string, SshConnectionState>
  onRemove: (targetId: string) => Promise<void>
  onResetRelay: (targetId: string) => Promise<void>
  onTerminateSessions: (targetId: string) => Promise<void>
  children: (actions: SshTargetDestructiveActionsRenderProps) => ReactNode
}

export function SshTargetDestructiveActions({
  connectionStates,
  onRemove,
  onResetRelay,
  onTerminateSessions,
  children
}: SshTargetDestructiveActionsProps): React.JSX.Element {
  const [pendingRemove, setPendingRemove] = useState<PendingTargetAction | null>(null)
  const [pendingReset, setPendingReset] = useState<PendingTargetAction | null>(null)
  const [pendingTerminate, setPendingTerminate] = useState<PendingTargetAction | null>(null)
  const mountedRef = useMountedRef()
  // Why: confirmed SSH actions keep running after the dialog click, so this
  // state blocks overlapping relay/session teardown for the same target.
  const targetActionsInFlightRef = useRef(new Map<string, SshTargetBusyAction>())
  const [targetActionsInFlight, setTargetActionsInFlight] = useState<
    Map<string, SshTargetBusyAction>
  >(new Map())
  const connectionStatesRef = useRef(connectionStates)
  connectionStatesRef.current = connectionStates

  const beginTargetAction = useCallback(
    (targetId: string, action: SshTargetBusyAction): boolean => {
      if (targetActionsInFlightRef.current.has(targetId)) {
        return false
      }

      const nextActions = new Map(targetActionsInFlightRef.current)
      nextActions.set(targetId, action)
      targetActionsInFlightRef.current = nextActions
      setTargetActionsInFlight(nextActions)
      return true
    },
    []
  )

  const finishTargetAction = useCallback(
    (targetId: string): void => {
      const nextActions = new Map(targetActionsInFlightRef.current)
      nextActions.delete(targetId)
      targetActionsInFlightRef.current = nextActions
      if (mountedRef.current) {
        setTargetActionsInFlight(nextActions)
      }
    },
    [mountedRef]
  )

  const runConfirmedTargetAction = async (
    pendingTarget: PendingTargetAction | null,
    action: SshTargetBusyAction,
    operation: (targetId: string) => Promise<void>,
    clearPendingTarget: () => void
  ): Promise<void> => {
    if (!pendingTarget || !beginTargetAction(pendingTarget.id, action)) {
      return
    }

    const targetId = pendingTarget.id
    try {
      await operation(targetId)
      if (mountedRef.current) {
        clearPendingTarget()
      }
    } finally {
      finishTargetAction(targetId)
    }
  }

  const pendingRemoveIsBusy =
    pendingRemove !== null && targetActionsInFlight.get(pendingRemove.id) === 'remove'
  const pendingResetIsBusy =
    pendingReset !== null && targetActionsInFlight.get(pendingReset.id) === 'reset'
  const pendingResetStatus =
    pendingReset !== null
      ? (connectionStates.get(pendingReset.id)?.status ?? 'disconnected')
      : 'disconnected'
  const pendingResetBlockedByConnection =
    pendingReset !== null && isSshTargetConnecting(pendingResetStatus)
  const pendingTerminateIsBusy =
    pendingTerminate !== null && targetActionsInFlight.get(pendingTerminate.id) === 'terminate'

  useEffect(() => {
    if (pendingResetBlockedByConnection && !pendingResetIsBusy) {
      setPendingReset(null)
    }
  }, [pendingResetBlockedByConnection, pendingResetIsBusy])

  const confirmResetRelay = async (): Promise<void> => {
    if (!pendingReset) {
      return
    }

    const latestStatus = connectionStatesRef.current.get(pendingReset.id)?.status ?? 'disconnected'
    if (isSshTargetConnecting(latestStatus)) {
      setPendingReset(null)
      return
    }

    await runConfirmedTargetAction(pendingReset, 'reset', onResetRelay, () => setPendingReset(null))
  }

  const actions: SshTargetDestructiveActionsRenderProps = {
    busyActionForTarget: (targetId) => targetActionsInFlight.get(targetId),
    requestRemove: (target) => {
      if (!targetActionsInFlightRef.current.has(target.id)) {
        setPendingRemove(target)
      }
    },
    requestResetRelay: (target) => {
      const status = connectionStatesRef.current.get(target.id)?.status ?? 'disconnected'
      if (!isSshTargetConnecting(status) && !targetActionsInFlightRef.current.has(target.id)) {
        setPendingReset(target)
      }
    },
    requestTerminateSessions: (target) => {
      if (!targetActionsInFlightRef.current.has(target.id)) {
        setPendingTerminate(target)
      }
    }
  }

  return (
    <>
      {children(actions)}

      <SshDestructiveActionDialog
        open={!!pendingRemove}
        title="Remove SSH Target"
        description="This will remove the target and end any active remote terminals."
        targetLabel={pendingRemove?.label}
        actionLabel="Remove"
        busyLabel="Removing"
        isBusy={pendingRemoveIsBusy}
        onOpenChange={(open) => {
          if (pendingRemoveIsBusy) {
            return
          }
          if (!open) {
            setPendingRemove(null)
          }
        }}
        onConfirm={() =>
          runConfirmedTargetAction(pendingRemove, 'remove', onRemove, () => setPendingRemove(null))
        }
      />

      <SshDestructiveActionDialog
        open={!!pendingReset && (!pendingResetBlockedByConnection || pendingResetIsBusy)}
        title="Reset Remote Relay?"
        description="This force-stops the remote relay for this SSH target. Active remote terminals and port forwards for this target will end."
        targetLabel={pendingReset?.label}
        actionLabel="Reset Relay"
        busyLabel="Resetting"
        isBusy={pendingResetIsBusy}
        onOpenChange={(open) => {
          if (pendingResetIsBusy) {
            return
          }
          if (!open) {
            setPendingReset(null)
          }
        }}
        onConfirm={confirmResetRelay}
      />

      <SshDestructiveActionDialog
        open={!!pendingTerminate}
        title="End Remote Terminals?"
        description="This will stop active terminal sessions on this SSH target. Reconnecting will not restore them."
        targetLabel={pendingTerminate?.label}
        actionLabel="End Terminals"
        busyLabel="Ending"
        isBusy={pendingTerminateIsBusy}
        onOpenChange={(open) => {
          if (pendingTerminateIsBusy) {
            return
          }
          if (!open) {
            setPendingTerminate(null)
          }
        }}
        onConfirm={() =>
          runConfirmedTargetAction(pendingTerminate, 'terminate', onTerminateSessions, () =>
            setPendingTerminate(null)
          )
        }
      />
    </>
  )
}
