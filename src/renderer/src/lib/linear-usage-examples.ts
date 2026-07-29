import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { ORCA_LINEAR_SKILL_NAME } from './agent-feature-install-commands'
import type { SkillUsageExample } from './skill-usage-example'

const LINEAR_SLASH_COMMAND = `/${ORCA_LINEAR_SKILL_NAME}`

export const getLinearUsageExamples = createLocalizedCatalog((): SkillUsageExample[] => [
  {
    id: 'read-ticket',
    title: translate('auto.lib.linear.usage.examples.readTicket', 'Read the linked ticket'),
    summary: translate(
      'auto.lib.linear.usage.examples.readTicketSummary',
      "Pull the linked Linear issue's full context before starting work."
    ),
    prompt: translate(
      'auto.lib.linear.usage.examples.readTicketPrompt',
      'Use {{value0}} to read the linked Linear issue for this worktree, then summarize the goal and acceptance criteria before you start.',
      { value0: LINEAR_SLASH_COMMAND }
    )
  },
  {
    id: 'post-update',
    title: translate('auto.lib.linear.usage.examples.postUpdate', 'Post a progress update'),
    summary: translate(
      'auto.lib.linear.usage.examples.postUpdateSummary',
      'Comment progress or a completion summary back to the Linear issue.'
    ),
    prompt: translate(
      'auto.lib.linear.usage.examples.postUpdatePrompt',
      'Use {{value0}} to post a completion update on the linked Linear issue with what changed and how it was verified.',
      { value0: LINEAR_SLASH_COMMAND }
    )
  },
  {
    id: 'move-state',
    title: translate('auto.lib.linear.usage.examples.moveState', 'Move the ticket forward'),
    summary: translate(
      'auto.lib.linear.usage.examples.moveStateSummary',
      'Advance the Linear workflow state as the work progresses.'
    ),
    prompt: translate(
      'auto.lib.linear.usage.examples.moveStatePrompt',
      'Use {{value0}} to move the linked Linear issue to In Review now that the change is ready.',
      { value0: LINEAR_SLASH_COMMAND }
    )
  },
  {
    id: 'attach-pr',
    title: translate('auto.lib.linear.usage.examples.attachPr', 'Attach the PR link'),
    summary: translate(
      'auto.lib.linear.usage.examples.attachPrSummary',
      'Link the pull request to the Linear issue when you open it.'
    ),
    prompt: translate(
      'auto.lib.linear.usage.examples.attachPrPrompt',
      'Use {{value0}} to attach this PR to the linked Linear issue with a PR link.',
      { value0: LINEAR_SLASH_COMMAND }
    )
  },
  {
    id: 'triage-followups',
    title: translate(
      'auto.lib.linear.usage.examples.triageFollowups',
      'Triage and create follow-ups'
    ),
    summary: translate(
      'auto.lib.linear.usage.examples.triageFollowupsSummary',
      'Set assignee, priority, or estimate, and file parented follow-up tickets.'
    ),
    prompt: translate(
      'auto.lib.linear.usage.examples.triageFollowupsPrompt',
      'Use {{value0}} to triage the linked Linear issue — set priority and estimate — and create a parented follow-up ticket for the deferred cleanup.',
      { value0: LINEAR_SLASH_COMMAND }
    )
  }
])
