// What the Connect Slack dialog shows for a step waiting on Slack's approval page, once the shared
// state says how that approval went.
import { readBotSlack, slackTeamState, useBotSlack, type BotSlackView } from '@/lib/bot-slack-state'
import type { Bot } from '../../../../../shared/bot-types'
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

/** How the approval for `teamId` went, from the shared Slack state; neither while it waits. */
export function slackApprovalOutcome(
  view: BotSlackView,
  teamId: string
): { installed: boolean; otherUser: boolean } {
  const team = view.status === 'ready' ? slackTeamState(view.slack, teamId) : null
  return {
    // Still behind, on required or optional permissions: the approval this flow waits for isn't in.
    installed: team?.state === 'installed' && !team.updateNeeded && !team.updateAvailable,
    otherUser: team?.state === 'created' && team.oauthFailure === 'other_user'
  }
}

/**
 * The approval outcome for `teamId` (null: no link), following the shared state while `follow` and
 * the outcome isn't in. Read even after the link expires: an approval that landed still wins. Ready
 * counts too: its link may have gone to another device without Copy link (a selection paste).
 */
export function useSlackApprovalOutcome(
  bot: Bot,
  teamId: string | null,
  follow: boolean,
  returnUrl: string | null
): { installed: boolean; otherUser: boolean } {
  const outcome = teamId
    ? slackApprovalOutcome(readBotSlack(bot), teamId)
    : { installed: false, otherUser: false }
  useBotSlack(bot, teamId !== null && follow && !outcome.installed && !outcome.otherUser, returnUrl)
  return outcome
}
