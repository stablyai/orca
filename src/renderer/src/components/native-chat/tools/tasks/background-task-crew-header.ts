import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AgentSessionBackgroundTask } from '../../../../../../shared/agent-session/background-tasks/agent-session-background-task-wire'
import { kindCountLabel } from '../../../../../../shared/agent-status/presentation/background-tasks/background-task-header-content'
import type { BackgroundTaskGroup } from '../../../../../../shared/agent-status/presentation/background-tasks/background-task-roster'
import type { OrchestrationCrewSummary } from '../../../../../../shared/orchestration/orchestration-crew'
import { sayBackgroundTaskTranslated as say } from './background-task-words-text'

export type CrewStripHeaderSegment = {
  key: 'needsYou' | AgentSessionBackgroundTask['kind']
  count: number
  text: string
}

const OTHER_KINDS = ['monitor', 'command', 'workflow', 'unknown'] as const

/** The strip's one line once a crew joins it: who needs you, everyone in the list, then the other kinds. */
export function crewStripHeader(
  groups: readonly BackgroundTaskGroup[],
  crew: Pick<OrchestrationCrewSummary, 'agents' | 'needsYou'>,
  t: Translate = translate
): CrewStripHeaderSegment[] {
  const subagents = groups.find((group) => group.kind === 'agent')?.tasks ?? []
  // A subagent's `waiting` is its approval prompt; workers' come counted from the host.
  const needsYou = crew.needsYou + subagents.filter((entry) => entry.state === 'waiting').length
  const agents = crew.agents + subagents.length
  const segments: CrewStripHeaderSegment[] = []
  if (needsYou > 0) {
    segments.push({
      key: 'needsYou',
      count: needsYou,
      text: t('components.native-chat.backgroundTasks.needsAttention', '{{count}} need attention', {
        count: needsYou,
        defaultValue_one: '{{count}} needs attention'
      })
    })
  }
  if (agents > 0) {
    segments.push({ key: 'agent', count: agents, text: kindCountLabel('agent', agents, say) })
  }
  for (const kind of OTHER_KINDS) {
    const count = groups.find((group) => group.kind === kind)?.tasks.length ?? 0
    if (count > 0) {
      segments.push({ key: kind, count, text: kindCountLabel(kind, count, say) })
    }
  }
  return segments
}
