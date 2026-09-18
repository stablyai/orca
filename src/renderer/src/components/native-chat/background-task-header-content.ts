// The background-tasks strip HEADER: the one line that speaks for the whole
// roster while the strip is collapsed. Counting and phrasing only — grouping,
// row state and the state vocabulary live in `background-task-roster.ts`.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from '../../../../shared/agent-session-wire'
import { translate } from '@/i18n/i18n'
import {
  backgroundTaskElapsedLabel,
  backgroundTaskStateReason,
  backgroundTaskStateWord,
  type BackgroundTaskGroup
} from './background-task-roster'

type TaskKind = AgentSessionBackgroundTask['kind']
type RunState = AgentSessionBackgroundTaskRunState

function kindCountLabel(kind: TaskKind, count: number): string {
  const value = { value0: count }
  switch (kind) {
    case 'agent':
      return count === 1
        ? translate('components.native-chat.backgroundTasks.countAgentsOne', '1 agent')
        : translate(
            'components.native-chat.backgroundTasks.countAgentsMany',
            '{{value0}} agents',
            value
          )
    case 'command':
      return count === 1
        ? translate('components.native-chat.backgroundTasks.countShellOne', '1 shell')
        : translate(
            'components.native-chat.backgroundTasks.countShellMany',
            '{{value0}} shells',
            value
          )
    case 'monitor':
      return count === 1
        ? translate('components.native-chat.backgroundTasks.countMonitorsOne', '1 monitor')
        : translate(
            'components.native-chat.backgroundTasks.countMonitorsMany',
            '{{value0}} monitors',
            value
          )
    case 'workflow':
      return count === 1
        ? translate('components.native-chat.backgroundTasks.countWorkflowsOne', '1 workflow')
        : translate(
            'components.native-chat.backgroundTasks.countWorkflowsMany',
            '{{value0}} workflows',
            value
          )
    case 'unknown':
      return count === 1
        ? translate('components.native-chat.backgroundTasks.countTasksOne', '1 task')
        : translate(
            'components.native-chat.backgroundTasks.countTasksMany',
            '{{value0}} tasks',
            value
          )
  }
}

/** How many kind segments the header may enumerate before an honest total
 *  replaces the breakdown entirely — never a partial enumeration. */
const HEADER_SEGMENT_CAP = 3

/** Done comes last but must be present: the headline counts settled rows too,
 *  so omitting it made the breakdown contradict its own count. */
const HEADER_STATE_ORDER: readonly RunState[] = [
  'working',
  'monitoring',
  'waiting',
  'blocked',
  'unverifiable',
  'idle',
  'done'
]

const ATTENTION_STATES: ReadonlySet<RunState> = new Set(['waiting', 'unverifiable', 'blocked'])

export type BackgroundTasksHeaderSegment = {
  text: string
  /** The kind this segment counts, so the renderer can lead it with that kind's
   *  icon. Null when the segment spans kinds (the collapsed total), which no
   *  single icon can stand for. */
  kind: TaskKind | null
}

export type BackgroundTasksHeaderContent = {
  /** Emphasised segments, joined with a muted separator by the renderer. */
  segments: BackgroundTasksHeaderSegment[]
  /** Muted " — …" tail; null when the segments say everything. */
  detail: string | null
}

/** Every variant in the signed-off mock, plus the overflow and narrow forms.
 *  Any lossy form (fallback or total) leaves the detail reachable — the strip
 *  stays expandable regardless of task count. */
export function backgroundTasksHeaderContent(
  groups: readonly BackgroundTaskGroup[],
  options: { narrow: boolean; now: number }
): BackgroundTasksHeaderContent {
  const all = groups.flatMap((group) => group.tasks)
  if (all.length === 0) {
    return {
      segments: [],
      detail: translate(
        'components.native-chat.backgroundTasks.monitoring',
        'Monitoring background tasks'
      )
    }
  }
  if (groups.length > HEADER_SEGMENT_CAP || (options.narrow && all.length > 1)) {
    return {
      segments: [
        {
          text: translate(
            'components.native-chat.backgroundTasks.headerTotal',
            '{{value0}} background tasks',
            {
              value0: all.length
            }
          ),
          kind: null
        }
      ],
      detail: null
    }
  }
  if (groups.length > 1) {
    return {
      segments: groups.map((group) => ({
        text: kindCountLabel(group.kind, group.tasks.length),
        kind: group.kind
      })),
      detail: null
    }
  }
  const group = groups[0]
  const count = group.tasks.length
  const uniformState = group.tasks.every((entry) => entry.state === group.tasks[0].state)
    ? group.tasks[0].state
    : null
  if (uniformState && ATTENTION_STATES.has(uniformState)) {
    return {
      segments: [
        {
          text: `${kindCountLabel(group.kind, count)} ${backgroundTaskStateWord(uniformState)}`,
          kind: group.kind
        }
      ],
      detail: backgroundTaskStateReason(uniformState)
    }
  }
  if (count === 1) {
    const entry = group.tasks[0]
    const subject =
      group.kind === 'command'
        ? translate(
            'components.native-chat.backgroundTasks.countShellCommandOne',
            '1 shell command'
          )
        : kindCountLabel(group.kind, 1)
    // A still-growing clock on finished work would lie, exactly as on the row.
    const elapsed =
      group.kind === 'command' && !entry.settled
        ? backgroundTaskElapsedLabel(entry.task, options.now)
        : null
    return {
      segments: [{ text: subject, kind: group.kind }],
      detail: elapsed ?? backgroundTaskStateWord(entry.state)
    }
  }
  const stateCounts = HEADER_STATE_ORDER.map((state) => ({
    state,
    count: group.tasks.filter((entry) => entry.state === state).length
  })).filter((entry) => entry.count > 0)
  return {
    segments: [{ text: kindCountLabel(group.kind, count), kind: group.kind }],
    // Done is accounted for in the muted detail but never earns its own emphasised
    // segment: a finished sibling claims no colour above the composer.
    detail:
      stateCounts.length > 0
        ? stateCounts
            .map((entry) => `${entry.count} ${backgroundTaskStateWord(entry.state)}`)
            .join(', ')
        : null
  }
}
