import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { SshDestructiveActionDialog } from './SshDestructiveActionDialog'
import type { SshTargetBusyAction } from './ssh-target-action-state'
import { translate } from '@/i18n/i18n'

type PendingTargetAction = { id: string; label: string }

type SshTargetDestructiveActionsRenderProps = {
  busyActionForTarget: (targetId: string) => SshTargetBusyAction | undefined
  requestRemove: (target: PendingTargetAction) => void
}

type SshTargetDestructiveActionsProps = {
  onRemove: (targetId: string) => Promise<void>
  children: (actions: SshTargetDestructiveActionsRenderProps) => ReactNode
}

export function SshTargetDestructiveActions({
  onRemove,
  children
}: SshTargetDestructiveActionsProps): React.JSX.Element {
  const [pendingRemove, setPendingRemove] = useState<PendingTargetAction | null>(null)
  const mountedRef = useMountedRef()
  // Why: a confirmed removal keeps running after the dialog click, so this
  // state blocks an overlapping removal of the same target.
  const targetActionsInFlightRef = useRef(new Map<string, SshTargetBusyAction>())
  const [targetActionsInFlight, setTargetActionsInFlight] = useState<
    Map<string, SshTargetBusyAction>
  >(new Map())

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
  const actions: SshTargetDestructiveActionsRenderProps = {
    busyActionForTarget: (targetId) => targetActionsInFlight.get(targetId),
    requestRemove: (target) => {
      if (!targetActionsInFlightRef.current.has(target.id)) {
        setPendingRemove(target)
      }
    }
  }

  return (
    <>
      {children(actions)}

      <SshDestructiveActionDialog
        open={!!pendingRemove}
        title={translate(
          'auto.components.settings.SshTargetDestructiveActions.4808966c41',
          'Remove SSH Target'
        )}
        description={translate(
          'auto.components.settings.SshTargetDestructiveActions.3bb0cf0ee4',
          'This will remove the target and end any active remote terminals.'
        )}
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
    </>
  )
}
