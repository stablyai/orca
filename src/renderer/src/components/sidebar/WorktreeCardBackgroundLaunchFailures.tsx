import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import { useOptionalConfirmationDialog } from '@/components/confirmation-dialog-context'
import { WorktreeAgentLaunchFailure } from './WorktreeAgentLaunchFailure'
import {
  forgetLaunchConfirmation,
  forgetSiblingsOptInLabel
} from '@/lib/agent-launch-recovery-action-copy'
import {
  resolveBackgroundAgentLaunchRecovery,
  type BackgroundAgentLaunchRecovery
} from '@/lib/background-agent-launch-recovery'
import {
  AGENTS_SETTINGS_ACTIONS,
  RETRY_SAME_ACTIONS
} from '@/lib/agent-launch-recovery-action-dispatch'
import {
  resolveWorktreeOperationRouteForHost,
  settingsForWorktreeOperationRoute
} from '@/lib/worktree-operation-route'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'
import type { AgentLaunchRecoveryActionId } from '@/lib/agent-launch-recovery-card'
import type { AppState } from '@/store/types'
import type { BackgroundAgentLaunchAttempt } from '../../../../shared/background-agent-launch'
import type { ExecutionHostId } from '../../../../shared/execution-host'

// Stable empty reference so the selector never returns a fresh array identity and
// re-renders in a loop when a worktree carries no background attempts.
const NO_ATTEMPTS: readonly BackgroundAgentLaunchAttempt[] = []

// Defensive read: this card is the sole consumer that projects worktree meta on
// every render of a sidebar row, so it tolerates a store snapshot whose
// worktreesByRepo slice is absent (the indexed selector would otherwise throw on
// Object.values(undefined)) rather than hardening the shared selector.
function selectBackgroundAttempts(
  state: AppState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): readonly BackgroundAgentLaunchAttempt[] {
  if (!state.worktreesByRepo) {
    return NO_ATTEMPTS
  }
  return (
    getWorktreeOnHostFromState(state, worktreeId, executionHostId)?.backgroundAgentLaunches ??
    NO_ATTEMPTS
  )
}

type SurfacedCard = {
  attempt: BackgroundAgentLaunchAttempt
  recovery: BackgroundAgentLaunchRecovery
}

/** Connected sidebar recovery card for a worktree's generic background agent-launch
 *  attempts (WorktreeMeta.backgroundAgentLaunches). Unattended background launches
 *  have no open terminal to surface the above-terminal card, so a failed/unknown
 *  attempt recovers here. Retry/Forget dispatch through the host RPC (keyed by the
 *  attempt id; the worktree id selects the runtime target so a remote attempt
 *  recovers over the paired connection); the host's worktrees:changed notification
 *  reconciles launched/forgotten back out of the meta, so this holds no attempt
 *  state of its own. Renders nothing until an attempt has a surfacing failure. */
export function WorktreeCardBackgroundLaunchFailures({
  worktreeId,
  executionHostId
}: {
  worktreeId: string
  executionHostId: ExecutionHostId
}): React.JSX.Element | null {
  const attempts = useAppStore((s) => selectBackgroundAttempts(s, worktreeId, executionHostId))
  const retryBackgroundAgentLaunch = useAppStore((s) => s.retryBackgroundAgentLaunch)
  const forgetBackgroundAgentLaunch = useAppStore((s) => s.forgetBackgroundAgentLaunch)
  const unknownAgentLaunchSiblingPreflight = useAppStore(
    (s) => s.unknownAgentLaunchSiblingPreflight
  )
  const forgetUnknownAgentLaunchSiblings = useAppStore((s) => s.forgetUnknownAgentLaunchSiblings)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openModal = useAppStore((s) => s.openModal)
  // Rendered inside WorktreeCard/WorktreeList isolation tests that omit the
  // provider; read the context softly so an absent provider degrades the
  // confirm-gated forget instead of throwing and crashing the host test family.
  const confirm = useOptionalConfirmationDialog()
  const [busyAttemptIds, setBusyAttemptIds] = useState<ReadonlySet<string>>(() => new Set())

  const setBusy = useCallback((attemptId: string, busy: boolean) => {
    setBusyAttemptIds((prev) => {
      const next = new Set(prev)
      if (busy) {
        next.add(attemptId)
      } else {
        next.delete(attemptId)
      }
      return next
    })
  }, [])

  const onAction = useCallback(
    async (
      attempt: BackgroundAgentLaunchAttempt,
      expectedFailureId: string,
      id: AgentLaunchRecoveryActionId
    ) => {
      if (RETRY_SAME_ACTIONS.has(id)) {
        setBusy(attempt.attemptId, true)
        try {
          await retryBackgroundAgentLaunch({
            attemptId: attempt.attemptId,
            worktreeId,
            executionHostId,
            expectedFailureId,
            action: { kind: 'retry-same' }
          })
        } finally {
          setBusy(attempt.attemptId, false)
        }
        return
      }
      if (id === 'forget-launch') {
        // Forget is destructive and must be confirmed; with no provider mounted
        // there is no way to confirm, so it cannot proceed.
        if (!confirm) {
          return
        }
        // Preflight the same-principal siblings stranded on the anchor's
        // disconnected host so the confirmation can offer the ":498 Also forget N…"
        // opt-in; a failed preflight must not block the single forget, so it
        // degrades to the plain confirmation.
        let siblingCount = 0
        let siblingHostName = ''
        try {
          const preflight = await unknownAgentLaunchSiblingPreflight({
            worktreeId,
            executionHostId
          })
          siblingCount = preflight.count
          siblingHostName = preflight.hostName
        } catch {
          siblingCount = 0
        }
        let forgetSiblings = false
        // Forget cannot stop a possibly-live remote process (plan :498), so it is
        // gated behind an explicit destructive confirmation carrying that warning.
        const confirmed = await confirm(
          // A blank host would render "…stranded launches on ." in a destructive dialog.
          // The preflight only returns an empty name for a local anchor, which is
          // contractually count:0 — degrade to the plain confirmation if that ever drifts.
          siblingCount > 0 && siblingHostName !== ''
            ? {
                ...forgetLaunchConfirmation(),
                optIn: {
                  label: forgetSiblingsOptInLabel(siblingCount, siblingHostName),
                  onConfirm: (checked) => {
                    forgetSiblings = checked
                  }
                }
              }
            : forgetLaunchConfirmation()
        )
        if (!confirmed) {
          return
        }
        // The attempt's operation id is the anti-race guard the host requires; it
        // is always present on a background attempt DTO (unlike the worktree card,
        // whose guard rides the possibly-reconciled pendingAgentLaunch).
        setBusy(attempt.attemptId, true)
        try {
          await forgetBackgroundAgentLaunch({
            attemptId: attempt.attemptId,
            worktreeId,
            executionHostId,
            expectedOperationId: attempt.operationId
          })
          // The bulk is worktree-scoped and clears only interactive siblings (the
          // structural guarantee keeps background-owned rows out of the count), so it
          // rides after the single attempt forget.
          if (forgetSiblings) {
            await forgetUnknownAgentLaunchSiblings({ worktreeId, executionHostId })
          }
        } finally {
          setBusy(attempt.attemptId, false)
        }
        return
      }
      if (AGENTS_SETTINGS_ACTIONS.has(id)) {
        // Repair/selection recovery lives in the desktop-host agents settings; a
        // live in-card picker for change-agent is future authoring UI (U8).
        openSettingsTarget({ pane: 'agents', repoId: null })
        return
      }
      if (id === 'reconnect' || id === 'reconnect-securely') {
        openSettingsTarget({ pane: 'ssh', repoId: null })
        return
      }
      if (id === 'recover-capacity') {
        // Query the host that rejected the launch: this worktree's runtime owner,
        // not the local host (whose summary knows nothing of a remote's capacity).
        const state = useAppStore.getState()
        const route = resolveWorktreeOperationRouteForHost(state, worktreeId, executionHostId)
        if (route) {
          openModal('agent-launch-capacity-recovery', {
            target: getActiveRuntimeTarget(settingsForWorktreeOperationRoute(state.settings, route))
          })
        }
      }
      // open-terminal routes to an affordance not owned by this wave; the no-op
      // keeps the card honest rather than firing a wrong action.
    },
    [
      worktreeId,
      executionHostId,
      confirm,
      setBusy,
      retryBackgroundAgentLaunch,
      forgetBackgroundAgentLaunch,
      unknownAgentLaunchSiblingPreflight,
      forgetUnknownAgentLaunchSiblings,
      openSettingsTarget,
      openModal
    ]
  )

  const cards = attempts.reduce<SurfacedCard[]>((acc, attempt) => {
    const recovery = resolveBackgroundAgentLaunchRecovery(attempt)
    if (recovery) {
      acc.push({ attempt, recovery })
    }
    return acc
  }, [])
  if (cards.length === 0) {
    return null
  }

  return (
    // Stop clicks/pointer gestures from bubbling to the card's activate/select and
    // drag handlers — the recovery buttons act only on themselves.
    <div
      className="mt-1.5 flex flex-col gap-1.5"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {cards.map(({ attempt, recovery }) => (
        <WorktreeAgentLaunchFailure
          key={attempt.attemptId}
          failure={recovery.failure}
          actions={recovery.model}
          busy={busyAttemptIds.has(attempt.attemptId)}
          onAction={(id) => void onAction(attempt, recovery.failure.failureId, id)}
        />
      ))}
    </div>
  )
}
