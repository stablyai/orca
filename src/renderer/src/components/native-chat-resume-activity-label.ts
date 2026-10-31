import { translate } from '@/i18n/i18n'
import type { AgentSessionRestartActivity } from '../../../shared/agent-session-restart-activity'

export type ResumeActivityLabel = {
  /** One line naming what the chat was doing, in the sidebar's own vocabulary. */
  summary: string
  /** Every task and prompt by name, for the row's tooltip. */
  detail: string
}

function named(label: string): string {
  return (
    label || translate('auto.components.NativeChatResumeOnRestartModal.activityUnnamed', 'unnamed')
  )
}

/** Read the host’s stop-time snapshot; older hosts/offers may omit it, so return null for caller fallback copy. */
export function resumeActivityLabel(
  activity: AgentSessionRestartActivity | undefined
): ResumeActivityLabel | null {
  if (!activity) {
    return null
  }
  const parts: string[] = []
  const [prompt] = activity.prompts
  // Describe the lead’s recorded state; completed leads leave the activity description to their children.
  if (activity.state === 'blocked' && prompt) {
    parts.push(
      prompt.kind === 'approval'
        ? translate(
            'auto.components.NativeChatResumeOnRestartModal.activityApproval',
            'Waiting for your approval: {{value0}}',
            { value0: named(prompt.label) }
          )
        : translate(
            'auto.components.NativeChatResumeOnRestartModal.activityQuestion',
            'Waiting for your answer: {{value0}}',
            { value0: named(prompt.label) }
          )
    )
  } else if (activity.state === 'working') {
    parts.push(
      translate('auto.components.NativeChatResumeOnRestartModal.activityMidReply', 'Was mid-reply')
    )
  }
  const agents = activity.tasks.filter((task) => task.kind === 'agent')
  // Not for a mid-reply lead: the roster also lists the reply's own foreground command.
  const watches =
    activity.state === 'working' ? [] : activity.tasks.filter((task) => task.kind !== 'agent')
  const [onlyAgent] = agents
  const [onlyWatch] = watches
  if (agents.length === 1 && onlyAgent) {
    parts.push(
      translate(
        'auto.components.NativeChatResumeOnRestartModal.activitySubagentOne',
        'Subagent running: {{value0}}',
        { value0: named(onlyAgent.label) }
      )
    )
  } else if (agents.length > 1) {
    parts.push(
      translate(
        'auto.components.NativeChatResumeOnRestartModal.activitySubagentCount',
        '{{count}} subagents running',
        { count: agents.length, defaultValue_one: '{{count}} subagent running' }
      )
    )
  }
  if (watches.length === 1 && onlyWatch) {
    parts.push(
      translate(
        'auto.components.NativeChatResumeOnRestartModal.activityMonitorOne',
        'Monitoring: {{value0}}',
        { value0: named(onlyWatch.label) }
      )
    )
  } else if (watches.length > 1) {
    parts.push(
      translate(
        'auto.components.NativeChatResumeOnRestartModal.activityMonitorCount',
        'Monitoring {{count}} background tasks',
        { count: watches.length, defaultValue_one: 'Monitoring {{count}} background task' }
      )
    )
  }
  if (parts.length === 0) {
    return null
  }
  return {
    summary: parts.join(' · '),
    detail: [...activity.prompts, ...activity.tasks]
      .map((entry) => entry.label)
      .filter(Boolean)
      .join('\n')
  }
}
