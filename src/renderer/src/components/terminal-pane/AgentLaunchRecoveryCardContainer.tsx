import { useCallback, useState } from 'react'
import { useAppStore } from '@/store'
import { getWorktreeMapFromState } from '@/store/selectors'
import { useOptionalConfirmationDialog } from '@/components/confirmation-dialog-context'
import { AgentLaunchRecoveryCard } from './AgentLaunchRecoveryCard'
import {
  forgetLaunchConfirmation,
  forgetSiblingsOptInLabel
} from '@/lib/agent-launch-recovery-action-copy'
import {
  AGENTS_SETTINGS_ACTIONS,
  RETRY_SAME_ACTIONS
} from '@/lib/agent-launch-recovery-action-dispatch'
import { getSettingsForWorktreeRuntimeOwner } from '@/lib/worktree-runtime-owner'
import { getActiveRuntimeTarget } from '@/runtime/runtime-client-target'
import type {
  AgentLaunchRecoveryActionId,
  AgentLaunchRecoveryLiveness
} from '@/lib/agent-launch-recovery-card'

const FORGET_WITHOUT_PENDING: ReadonlySet<AgentLaunchRecoveryActionId> = new Set(['forget-launch'])

/** Connected recovery card for a post-create agent-launch failure. Reads the
 *  durable failure from the workspace's WorktreeMeta mirror and renders nothing
 *  until the host records one. Retry/Forget are fully wired here; the host's
 *  worktrees:changed notification reconciles launched/failed back into the meta,
 *  so this component holds no failure state of its own. */
export function AgentLaunchRecoveryCardContainer({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const failure = useAppStore(
    (s) => getWorktreeMapFromState(s).get(worktreeId)?.agentLaunchFailure ?? null
  )
  const pendingOperationId = useAppStore(
    (s) => getWorktreeMapFromState(s).get(worktreeId)?.pendingAgentLaunch?.operationId ?? null
  )
  const retryWorktreeAgentLaunch = useAppStore((s) => s.retryWorktreeAgentLaunch)
  const forgetWorktreeAgentLaunch = useAppStore((s) => s.forgetWorktreeAgentLaunch)
  const unknownAgentLaunchSiblingPreflight = useAppStore(
    (s) => s.unknownAgentLaunchSiblingPreflight
  )
  const forgetUnknownAgentLaunchSiblings = useAppStore((s) => s.forgetUnknownAgentLaunchSiblings)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const openModal = useAppStore((s) => s.openModal)
  // Read the confirm context softly so rendering inside a host family's
  // provider-less isolation test degrades the confirm-gated forget instead of
  // throwing (the same crash class that took out the WorktreeCard family).
  const confirm = useOptionalConfirmationDialog()
  const [busy, setBusy] = useState(false)

  const onAction = useCallback(
    async (id: AgentLaunchRecoveryActionId) => {
      if (!failure) {
        return
      }
      if (RETRY_SAME_ACTIONS.has(id)) {
        setBusy(true)
        try {
          await retryWorktreeAgentLaunch({
            worktreeId,
            expectedFailureId: failure.failureId,
            action: { kind: 'retry-same' }
          })
        } finally {
          setBusy(false)
        }
        return
      }
      if (id === 'forget-launch') {
        // Forget is destructive and must be confirmed; with no provider mounted
        // there is no way to confirm, so it cannot proceed.
        if (!confirm) {
          return
        }
        // The pending operation id is the anti-race guard the host requires; a
        // missing one means reconciliation already cleared the pending, so there
        // is nothing to forget.
        if (!pendingOperationId) {
          return
        }
        // Preflight the same-principal siblings stranded on the anchor's
        // disconnected host so the confirmation can offer the ":498 Also forget N…"
        // opt-in; a failed preflight (e.g. a momentarily unreachable host) must not
        // block the single forget, so it degrades to the plain confirmation.
        let siblingCount = 0
        let siblingHostName = ''
        try {
          const preflight = await unknownAgentLaunchSiblingPreflight({ worktreeId })
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
        setBusy(true)
        try {
          await forgetWorktreeAgentLaunch({ worktreeId, expectedOperationId: pendingOperationId })
          if (forgetSiblings) {
            await forgetUnknownAgentLaunchSiblings({ worktreeId })
          }
        } finally {
          setBusy(false)
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
        // The summary is principal-scoped on whichever host rejected the launch,
        // so the sheet must query THIS workspace's runtime owner — a remote Orca
        // server's capacity is invisible to the local host's summary.
        openModal('agent-launch-capacity-recovery', {
          target: getActiveRuntimeTarget(
            getSettingsForWorktreeRuntimeOwner(useAppStore.getState(), worktreeId)
          )
        })
      }
      // open-terminal routes to an affordance not owned by this wave; the
      // no-op keeps the card honest rather than firing a wrong action.
    },
    [
      failure,
      pendingOperationId,
      worktreeId,
      confirm,
      retryWorktreeAgentLaunch,
      forgetWorktreeAgentLaunch,
      unknownAgentLaunchSiblingPreflight,
      forgetUnknownAgentLaunchSiblings,
      openSettingsTarget,
      openModal
    ]
  )

  if (!failure) {
    return null
  }
  // Liveness dominates the code, but the only liveness the renderer can derive
  // from the durable record is the provider-disconnected `launch_state_unknown`;
  // a live-but-unattributed terminal is host-reconciliation state (U6) with no
  // persisted failure, so it never reaches this card.
  const liveness: AgentLaunchRecoveryLiveness =
    failure.code === 'launch_state_unknown' ? 'unknown' : 'idle'

  return (
    <AgentLaunchRecoveryCard
      failure={failure}
      liveness={liveness}
      busy={busy}
      // No pending op id → the host would reject the forget (anti-race guard);
      // disable rather than offer a silent no-op button.
      disabledActionIds={pendingOperationId ? undefined : FORGET_WITHOUT_PENDING}
      onAction={onAction}
    />
  )
}
