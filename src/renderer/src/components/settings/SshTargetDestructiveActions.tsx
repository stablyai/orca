import { useCallback, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { SshDestructiveActionDialog } from './SshDestructiveActionDialog'
import type { SshTargetBusyAction } from './ssh-target-action-state'
import { translate } from '@/i18n/i18n'

type PendingTargetAction = { id: string; label: string }

export type SshBulkRemoveRequest = {
  targets: PendingTargetAction[]
  /** Connected hosts lose their remote terminals; the confirm says how many. */
  connectedCount: number
}

export type SshBulkRemoveResult = {
  removed: PendingTargetAction[]
  failed: { target: PendingTargetAction; error: unknown }[]
}

type SshTargetDestructiveActionsRenderProps = {
  busyActionForTarget: (targetId: string) => SshTargetBusyAction | undefined
  requestRemove: (target: PendingTargetAction) => void
  requestBulkRemove: (request: SshBulkRemoveRequest) => void
}

type SshTargetDestructiveActionsProps = {
  onRemove: (targetId: string) => Promise<void>
  /** One removal inside a bulk run; throws on failure and leaves reporting to the summary. */
  removeQuietly?: (targetId: string) => Promise<void>
  onBulkRemoveFinished?: (result: SshBulkRemoveResult) => void | Promise<void>
  children: (actions: SshTargetDestructiveActionsRenderProps) => ReactNode
}

export function SshTargetDestructiveActions({
  onRemove,
  removeQuietly,
  onBulkRemoveFinished,
  children
}: SshTargetDestructiveActionsProps): React.JSX.Element {
  const [pendingRemove, setPendingRemove] = useState<PendingTargetAction | null>(null)
  const [pendingBulk, setPendingBulk] = useState<SshBulkRemoveRequest | null>(null)
  const [bulkProgress, setBulkProgress] = useState<number | null>(null)
  const mountedRef = useMountedRef()
  // Hold per-target ownership through confirmed removal to block overlapping destructive actions.
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

  const runBulkRemove = async (): Promise<void> => {
    if (!pendingBulk || bulkProgress !== null) {
      return
    }
    // Remove serially because each operation rewrites the same store and tears down host PTYs.
    const claimed = pendingBulk.targets.filter((target) => beginTargetAction(target.id, 'remove'))
    const result: SshBulkRemoveResult = { removed: [], failed: [] }
    const remove = removeQuietly ?? onRemove
    try {
      for (const [index, target] of claimed.entries()) {
        if (mountedRef.current) {
          setBulkProgress(index + 1)
        }
        try {
          await remove(target.id)
          result.removed.push(target)
        } catch (err) {
          result.failed.push({ target, error: err })
        } finally {
          finishTargetAction(target.id)
        }
      }
    } finally {
      if (mountedRef.current) {
        setBulkProgress(null)
        setPendingBulk(null)
      }
    }
    await onBulkRemoveFinished?.(result)
  }

  const pendingRemoveIsBusy =
    pendingRemove !== null && targetActionsInFlight.get(pendingRemove.id) === 'remove'
  const actions: SshTargetDestructiveActionsRenderProps = {
    busyActionForTarget: (targetId) => targetActionsInFlight.get(targetId),
    requestRemove: (target) => {
      if (!targetActionsInFlightRef.current.has(target.id)) {
        setPendingRemove(target)
      }
    },
    requestBulkRemove: (request) => {
      const targets = request.targets.filter(
        (target) => !targetActionsInFlightRef.current.has(target.id)
      )
      if (targets.length > 0 && bulkProgress === null) {
        setPendingBulk({ ...request, targets })
      }
    }
  }
  const bulkCount = pendingBulk?.targets.length ?? 0

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

      <SshDestructiveActionDialog
        open={!!pendingBulk}
        title={
          bulkCount === 1
            ? translate(
                'auto.components.settings.SshTargetDestructiveActions.bulkTitleSingular',
                'Remove {{count}} SSH host?',
                { count: bulkCount }
              )
            : translate(
                'auto.components.settings.SshTargetDestructiveActions.bulkTitlePlural',
                'Remove {{count}} SSH hosts?',
                { count: bulkCount }
              )
        }
        description={translate(
          'auto.components.settings.SshTargetDestructiveActions.bulkDescription',
          'Removed hosts disappear from host pickers in workspaces, automations and the sidebar. Your ~/.ssh/config is not changed, and later syncs won’t bring them back.'
        )}
        targetLabels={pendingBulk?.targets.map((target) => target.label)}
        notice={
          !pendingBulk || pendingBulk.connectedCount === 0
            ? undefined
            : pendingBulk.connectedCount === 1
              ? translate(
                  'auto.components.settings.SshTargetDestructiveActions.bulkConnectedSingular',
                  '{{count}} host is connected. Its remote terminals will be closed.',
                  { count: 1 }
                )
              : translate(
                  'auto.components.settings.SshTargetDestructiveActions.bulkConnectedPlural',
                  '{{count}} hosts are connected. Their remote terminals will be closed.',
                  { count: pendingBulk.connectedCount }
                )
        }
        actionLabel={translate(
          'auto.components.settings.SshTargetDestructiveActions.bulkAction',
          'Remove {{count}}',
          { count: bulkCount }
        )}
        busyLabel={translate(
          'auto.components.settings.SshTargetDestructiveActions.bulkProgress',
          'Removing {{done}} of {{count}}…',
          { done: bulkProgress ?? 0, count: bulkCount }
        )}
        isBusy={bulkProgress !== null}
        onOpenChange={(open) => {
          if (!open && bulkProgress === null) {
            setPendingBulk(null)
          }
        }}
        onConfirm={runBulkRemove}
      />
    </>
  )
}
