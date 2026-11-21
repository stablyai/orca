// @protected-copy: drawn inside the security-surface setup dialog
// The step the dialog draws while Slack's page is out: the wait, or how it ended as the cloud reads it.
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import { slackInstallState } from './slack-install-link'
import type { BotSlackSetupStep } from './use-bot-slack-setup'

export function shownSlackSetupStep(
  step: BotSlackSetupStep,
  /** The waited-for workspace's state, read while waiting; null otherwise. */
  waited: ConnectorBotSlackState | null,
  expired: boolean
): BotSlackSetupStep {
  if (step.kind !== 'waiting' && step.kind !== 'ready') {
    return step
  }
  // Still behind, on required or optional permissions: the approval this flow waits for isn't in.
  if (waited?.state === 'installed' && !waited.updateNeeded && !waited.updateAvailable) {
    const setupState = step.link ? slackInstallState(step.link.authorizeUrl) : null
    return { kind: 'installed', teamId: step.teamId, ...(setupState ? { setupState } : {}) }
  }
  if (waited?.state === 'created' && waited.oauthFailure === 'other_user') {
    return { kind: 'other-user', teamId: step.teamId }
  }
  return expired ? { kind: 'expired', teamId: step.teamId } : step
}
