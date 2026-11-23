// What the Connect Slack dialog shows for a step waiting on Slack's approval page, once the shared
// state says how that approval went.
import { slackInstallState } from './slack-install-link'
import type { BotSlackSetupStep } from './use-bot-slack-setup'

export function slackSetupShownStep(
  step: BotSlackSetupStep,
  outcome: { installed: boolean; otherUser: boolean; expired: boolean }
): BotSlackSetupStep {
  if (step.kind !== 'waiting' && step.kind !== 'ready') {
    return step
  }
  if (outcome.installed) {
    const setupState = step.link ? slackInstallState(step.link.authorizeUrl) : null
    return { kind: 'installed', teamId: step.teamId, ...(setupState ? { setupState } : {}) }
  }
  if (outcome.otherUser) {
    return { kind: 'other-user', teamId: step.teamId }
  }
  return outcome.expired ? { kind: 'expired', teamId: step.teamId } : step
}
