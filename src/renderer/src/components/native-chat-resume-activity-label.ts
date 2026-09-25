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

/** What an offered chat was doing when Orca went away, read from the offer's own stop-time
 *  snapshot. Null when the host sent none — an older host, or an offer recorded by a build that
 *  captured no snapshot — which the dialog's own wording already covers. */
export function resumeActivityLabel(
  activity: AgentSessionRestartActivity | undefined
): ResumeActivityLabel | null {
  if (!activity) {
    return null
  }
  const parts: string[] = []
  const [prompt] = activity.prompts
  // The headline is the main agent's own recorded state: blocked names the prompt it was waiting
  // on, working was a reply in progress, done says nothing — its children speak below.
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
        'auto.components.NativeChatResumeOnRestartModal.activitySubagentMany',
        '{{value0}} subagents running',
        { value0: agents.length }
      )
    )
  }
  // Shells, monitors and workflows alone are what the sidebar labels monitoring.
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
        'auto.components.NativeChatResumeOnRestartModal.activityMonitorMany',
        'Monitoring {{value0}} background tasks',
        { value0: watches.length }
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
