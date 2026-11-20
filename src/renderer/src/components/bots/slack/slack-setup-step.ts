import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import { slackInstallState } from './slack-install-link'
import type { BotSlackSetupStep } from './use-bot-slack-setup'

export function shownSlackSetupStep(
  step: BotSlackSetupStep,
  current: ConnectorBotSlackState | null,
  expired: boolean
): BotSlackSetupStep {
  const installed =
    current?.state === 'installed' && !current.updateNeeded && !current.updateAvailable
  if (step.kind === 'prepare' && installed) {
    return { kind: 'installed', teamId: step.teamId }
  }
  if (step.kind !== 'waiting' && step.kind !== 'ready') {
    return step
  }
  if (installed) {
    const setupState = step.link ? slackInstallState(step.link.authorizeUrl) : null
    return { kind: 'installed', teamId: step.teamId, ...(setupState ? { setupState } : {}) }
  }
  if (current?.state === 'created' && current.oauthFailure === 'other_user') {
    return { kind: 'other-user', teamId: step.teamId }
  }
  return expired ? { kind: 'expired', teamId: step.teamId } : step
}
