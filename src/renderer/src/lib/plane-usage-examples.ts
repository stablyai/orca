import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { ORCA_PLANE_SKILL_NAME } from './agent-feature-install-commands'
import type { SkillUsageExample } from './skill-usage-example'

const PLANE_SLASH_COMMAND = `/${ORCA_PLANE_SKILL_NAME}`

export const getPlaneUsageExamples = createLocalizedCatalog((): SkillUsageExample[] => [
  {
    id: 'read-ticket',
    title: translate('auto.lib.plane.usage.examples.readTicket', 'Read the linked issue'),
    summary: translate(
      'auto.lib.plane.usage.examples.readTicketSummary',
      "Pull the linked Plane issue's full context before starting work."
    ),
    prompt: translate(
      'auto.lib.plane.usage.examples.readTicketPrompt',
      'Use {{value0}} to read the linked Plane issue for this worktree, then summarize the goal and acceptance criteria before you start.',
      { value0: PLANE_SLASH_COMMAND }
    )
  },
  {
    id: 'post-update',
    title: translate('auto.lib.plane.usage.examples.postUpdate', 'Post a progress update'),
    summary: translate(
      'auto.lib.plane.usage.examples.postUpdateSummary',
      'Comment progress or a completion summary back to the Plane issue.'
    ),
    prompt: translate(
      'auto.lib.plane.usage.examples.postUpdatePrompt',
      'Use {{value0}} to post a completion update on the linked Plane issue with what changed and how it was verified.',
      { value0: PLANE_SLASH_COMMAND }
    )
  },
  {
    id: 'move-state',
    title: translate('auto.lib.plane.usage.examples.moveState', 'Move the issue forward'),
    summary: translate(
      'auto.lib.plane.usage.examples.moveStateSummary',
      'Advance the Plane workflow state as the work progresses.'
    ),
    prompt: translate(
      'auto.lib.plane.usage.examples.moveStatePrompt',
      'Use {{value0}} to move the linked Plane issue to In Progress or In Review now that the change is underway.',
      { value0: PLANE_SLASH_COMMAND }
    )
  },
  {
    id: 'triage-priority',
    title: translate('auto.lib.plane.usage.examples.triagePriority', 'Triage and set priority'),
    summary: translate(
      'auto.lib.plane.usage.examples.triagePrioritySummary',
      'Update priority or state on the Plane issue as scope is clarified.'
    ),
    prompt: translate(
      'auto.lib.plane.usage.examples.triagePriorityPrompt',
      'Use {{value0}} to triage the linked Plane issue — update its priority to urgent/high/medium/low and adjust state.',
      { value0: PLANE_SLASH_COMMAND }
    )
  },
  {
    id: 'create-followup',
    title: translate(
      'auto.lib.plane.usage.examples.createFollowup',
      'Create a follow-up issue'
    ),
    summary: translate(
      'auto.lib.plane.usage.examples.createFollowupSummary',
      'File a new Plane issue for deferred work or related bugs found during development.'
    ),
    prompt: translate(
      'auto.lib.plane.usage.examples.createFollowupPrompt',
      'Use {{value0}} to create a new Plane issue for the deferred follow-up work.',
      { value0: PLANE_SLASH_COMMAND }
    )
  }
])
