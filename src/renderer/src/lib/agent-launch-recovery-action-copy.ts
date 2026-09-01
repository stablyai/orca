// Localized labels and destructive classification for agent-launch recovery
// actions. Shared by the interactive above-terminal recovery card and the compact
// sidebar unattended-failure card so both surfaces render one action vocabulary.

import { translate } from '@/i18n/i18n'
import type { AgentLaunchRecoveryActionId } from '@/lib/agent-launch-recovery-card'

/** Localized button label for a recovery action. */
export function recoveryActionLabel(id: AgentLaunchRecoveryActionId): string {
  switch (id) {
    case 'retry':
      return translate('auto.components.AgentLaunchRecoveryCard.retry', 'Retry')
    case 'retry-current-settings':
      return translate(
        'auto.components.AgentLaunchRecoveryCard.retryCurrentSettings',
        'Retry with current settings'
      )
    case 'launch-current-settings':
      return translate(
        'auto.components.AgentLaunchRecoveryCard.launchCurrentSettings',
        'Launch with current settings'
      )
    case 'choose-agent':
      return translate('auto.components.AgentLaunchRecoveryCard.chooseAgent', 'Choose agent')
    case 'edit-agent-settings':
      return translate(
        'auto.components.AgentLaunchRecoveryCard.editAgentSettings',
        'Edit agent settings'
      )
    case 'repair-on-host':
      return translate(
        'auto.components.AgentLaunchRecoveryCard.repairOnHost',
        'Repair on desktop host'
      )
    case 'reconnect-securely':
      return translate(
        'auto.components.AgentLaunchRecoveryCard.reconnectSecurely',
        'Reconnect securely'
      )
    case 'reconnect':
      return translate('auto.components.AgentLaunchRecoveryCard.reconnect', 'Reconnect')
    case 'recover-capacity':
      return translate(
        'auto.components.AgentLaunchRecoveryCard.recoverCapacity',
        'Recover launch capacity…'
      )
    case 'open-terminal':
      return translate('auto.components.AgentLaunchRecoveryCard.openTerminal', 'Open terminal')
    case 'forget-launch':
      return translate('auto.components.AgentLaunchRecoveryCard.forgetLaunch', 'Forget launch…')
    case 'manage-agents':
      return translate('auto.components.AgentLaunchRecoveryCard.manageAgents', 'Manage agents')
  }
}

/** Forget is a destructive confirmation; every other action is safe. */
export function isDestructiveRecoveryAction(id: AgentLaunchRecoveryActionId): boolean {
  return id === 'forget-launch'
}

/** Destructive Forget-launch confirmation copy (plan :498): forgetting frees
 *  Orca's bookkeeping but cannot stop a possibly-live remote process, so the user
 *  confirms with that warning before an unknown launch is forgotten. */
export function forgetLaunchConfirmation(): {
  title: string
  description: string
  confirmLabel: string
  confirmVariant: 'destructive'
} {
  return {
    title: translate('agentLaunch.forgetConfirm.title', 'Forget this launch?'),
    description: translate(
      'agentLaunch.forgetConfirm.warning',
      'Orca cannot reach the terminal host. Forgetting does not stop the remote process; it may still be running.'
    ),
    confirmLabel: translate('agentLaunch.forgetConfirm.confirmLabel', 'Forget launch'),
    confirmVariant: 'destructive'
  }
}

/** Opt-in offered on the Forget confirmation when the same authenticated principal
 *  has other unknown launches stranded on the same disconnected host (plan :498).
 *  Selecting it forgets those siblings alongside this one. Caller supplies the
 *  host-side sibling count and the target-host display name. */
export function forgetSiblingsOptInLabel(count: number, hostName: string): string {
  if (count === 1) {
    return translate(
      'agentLaunch.forgetConfirm.alsoForgetSibling',
      'Also forget 1 other stranded launch on {{host}}.',
      { host: hostName }
    )
  }
  return translate(
    'agentLaunch.forgetConfirm.alsoForgetSiblings',
    'Also forget {{count}} other stranded launches on {{host}}.',
    { count, host: hostName }
  )
}
