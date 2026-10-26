// Collapsed roster header counts/phrases only; grouping and states belong to background-task-roster.ts.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from './agent-session-background-task-wire'
import type { BackgroundTaskSay } from './background-task-copy'
import {
  backgroundTaskCountedState,
  backgroundTaskElapsedLabel,
  backgroundTaskStateReason,
  backgroundTaskStateWord,
  type BackgroundTaskGroup
} from './background-task-roster'

type TaskKind = AgentSessionBackgroundTask['kind']
type RunState = AgentSessionBackgroundTaskRunState

/** Below this strip width in rem (16px fallback), replace multi-kind breakdowns with totals. Single-kind state forms still fit; measure the strip so split panes behave like narrow windows. */
export const NARROW_BACKGROUND_TASKS_STRIP_REM = 24

function kindCountLabel(kind: TaskKind, count: number, say: BackgroundTaskSay): string {
  const value = { value0: count }
  switch (kind) {
    case 'agent':
      return count === 1 ? say('countAgentsOne') : say('countAgentsMany', value)
    case 'command':
      return count === 1 ? say('countShellOne') : say('countShellMany', value)
    case 'monitor':
      return count === 1 ? say('countMonitorsOne') : say('countMonitorsMany', value)
    case 'workflow':
      return count === 1 ? say('countWorkflowsOne') : say('countWorkflowsMany', value)
    case 'unknown':
      return count === 1 ? say('countTasksOne') : say('countTasksMany', value)
  }
}

/** Replace oversized kind breakdowns entirely; never enumerate a misleading subset. */
const HEADER_SEGMENT_CAP = 3

/** Include done last: settled rows count in the headline and must also count in the breakdown. */
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
  /** Icon kind, or null for multi-kind totals no single icon can represent. */
  kind: TaskKind | null
}

export type BackgroundTasksHeaderContent = {
  /** Emphasised segments, joined with a muted separator by the renderer. */
  segments: BackgroundTasksHeaderSegment[]
  /** Muted " — …" tail; null when the segments say everything. */
  detail: string | null
}

/** Narrow replaces only multi-kind breakdowns. Any lossy total/fallback stays expandable, regardless of count, so detail remains reachable. */
export function backgroundTasksHeaderContent(
  groups: readonly BackgroundTaskGroup[],
  options: { narrow: boolean; now: number },
  say: BackgroundTaskSay
): BackgroundTasksHeaderContent {
  const all = groups.flatMap((group) => group.tasks)
  if (all.length === 0) {
    return { segments: [], detail: say('monitoring') }
  }
  if (groups.length > HEADER_SEGMENT_CAP || (options.narrow && groups.length > 1)) {
    return {
      segments: [{ text: say('headerTotal', { value0: all.length }), kind: null }],
      detail: null
    }
  }
  if (groups.length > 1) {
    return {
      segments: groups.map((group) => ({
        text: kindCountLabel(group.kind, group.tasks.length, say),
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
          text: backgroundTaskCountedState(
            kindCountLabel(group.kind, count, say),
            uniformState,
            say
          ),
          kind: group.kind
        }
      ],
      detail: backgroundTaskStateReason(uniformState, say)
    }
  }
  if (count === 1) {
    const entry = group.tasks[0]
    const subject =
      group.kind === 'command' ? say('countShellCommandOne') : kindCountLabel(group.kind, 1, say)
    // A still-growing clock on finished work would lie, exactly as on the row.
    const elapsed =
      group.kind === 'command' && !entry.row.settled
        ? backgroundTaskElapsedLabel(entry.row.firstObservedAt, options.now)
        : null
    return {
      segments: [{ text: subject, kind: group.kind }],
      detail: elapsed ?? backgroundTaskStateWord(entry.state, say)
    }
  }
  const stateCounts = HEADER_STATE_ORDER.map((state) => ({
    state,
    count: group.tasks.filter((entry) => entry.state === state).length
  })).filter((entry) => entry.count > 0)
  return {
    segments: [{ text: kindCountLabel(group.kind, count, say), kind: group.kind }],
    // Count done in muted detail, never an emphasized segment: finished siblings claim no composer color.
    detail:
      stateCounts.length > 0
        ? stateCounts
            .map((entry) => backgroundTaskCountedState(entry.count, entry.state, say))
            .join(', ')
        : null
  }
}

/** The header as one line, for an accessibility label. */
export function backgroundTasksHeaderText(header: BackgroundTasksHeaderContent): string {
  const segments = header.segments.map((segment) => segment.text).join(' · ')
  return `${segments}${header.detail ? `${header.segments.length > 0 ? ' — ' : ''}${header.detail}` : ''}`
}
