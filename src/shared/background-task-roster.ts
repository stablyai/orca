// Grouping, naming, and state words for the background-tasks strip. Pure functions over the wire
// roster so every surface (desktop strip, phone strip) groups and words one roster the same way;
// each passes its own `say` for the words.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from './agent-session-background-task-wire'
import type { BackgroundTaskSay } from './background-task-copy'
import {
  buildAgentChildRowModels,
  buildLegacyTaskRowModels,
  usableAgentChildLabel,
  type AgentChildRowContext,
  type AgentChildRowModel
} from './agent-child-row-model'
import { agentChildRunStateFor } from './agent-status-child-work-display'
import type { AgentChildWorkView } from './agent-status-child-work-view'
import { formatNativeChatDuration } from './native-chat-turn-status'

type TaskKind = AgentSessionBackgroundTask['kind']
type RunState = AgentSessionBackgroundTaskRunState

export type BackgroundRosterTask = {
  /** What the row shows, decided by the same model the sidebar's child rows use. */
  row: AgentChildRowModel
  /** The row's display state in the header's vocabulary. */
  state: RunState
}

export type BackgroundTaskGroup = { kind: TaskKind; tasks: BackgroundRosterTask[] }

/** Fixed presentation order; groups render only when non-empty. */
const KIND_ORDER: readonly TaskKind[] = ['agent', 'command', 'monitor', 'workflow', 'unknown']

export function backgroundTaskKindLabel(kind: TaskKind, say: BackgroundTaskSay): string {
  switch (kind) {
    case 'agent':
      return say('agent')
    case 'workflow':
      return say('workflow')
    case 'command':
      return say('command')
    case 'monitor':
      return say('monitor')
    case 'unknown':
      return say('task')
  }
}

/** The transcript row's name: description → name → kind label. Empty-after-trim and
 *  placeholder values fall through, so the row always renders something. */
export function resolveBackgroundTaskName(
  task: AgentSessionBackgroundTask,
  say: BackgroundTaskSay
): string {
  return (
    usableAgentChildLabel(task.description) ??
    usableAgentChildLabel(task.name) ??
    backgroundTaskKindLabel(task.kind, say)
  )
}

/** Stable-sort first-seen then id, so a live update never reshuffles surviving rows. */
function groupRosterEntries(entries: BackgroundRosterTask[]): BackgroundTaskGroup[] {
  entries.sort((left, right) => {
    const startDelta = left.row.firstObservedAt - right.row.firstObservedAt
    return startDelta !== 0 ? startDelta : left.row.id < right.row.id ? -1 : 1
  })
  return KIND_ORDER.map((kind) => ({
    kind,
    tasks: entries.filter((entry) => entry.row.kind === kind)
  })).filter((group) => group.tasks.length > 0)
}

function rosterEntries(rows: readonly AgentChildRowModel[]): BackgroundTaskGroup[] {
  return groupRosterEntries(
    rows.map((row) => ({ row, state: agentChildRunStateFor(row.displayState) }))
  )
}

/** Kind groups from a host that publishes only the task roster, live and settled merged. */
export function buildBackgroundTaskGroups(
  tasks: readonly AgentSessionBackgroundTask[],
  settledTasks: readonly AgentSessionBackgroundTask[],
  say: BackgroundTaskSay
): BackgroundTaskGroup[] {
  // An old host's unlabeled row keeps the kind label it always showed; a view row reads its state.
  return rosterEntries(
    buildLegacyTaskRowModels(tasks, settledTasks).map((row) =>
      row.name ? row : { ...row, name: backgroundTaskKindLabel(row.kind, say) }
    )
  )
}

// Until a caller passes the session's parent-row context, every live claim stands as reported.
const REPORTED_ROW_CONTEXT: AgentChildRowContext = {
  parentEvidenceFresh: true,
  transportObservation: 'live',
  parentObservedAt: 0,
  hostClockOffsetMs: 0
}

/** Kind groups from the host's child views: the main agent's work at the top, each child's own
 *  work nested beneath it rather than counted again in its kind's group. Pass the context the
 *  sidebar builds for the same parent (`agentChildRowContextForParent`) so both read one verdict. */
export function buildBackgroundTaskGroupsFromViews(
  views: readonly AgentChildWorkView[],
  context: AgentChildRowContext = REPORTED_ROW_CONTEXT
): BackgroundTaskGroup[] {
  return rosterEntries(buildAgentChildRowModels(views, context))
}

export function backgroundTaskStateWord(state: RunState, say: BackgroundTaskSay): string {
  switch (state) {
    case 'working':
      return say('stateWorking')
    case 'monitoring':
      return say('stateMonitoring')
    case 'waiting':
      return say('stateWaiting')
    case 'blocked':
      return say('stateBlocked')
    case 'done':
      return say('stateDone')
    case 'idle':
      return say('stateIdle')
    case 'unverifiable':
      return say('stateUnverifiable')
  }
}

/** The reason line for an attention state, per the signed-off mock. */
export function backgroundTaskStateReason(state: RunState, say: BackgroundTaskSay): string | null {
  switch (state) {
    case 'waiting':
      return say('reasonWaiting')
    case 'blocked':
      return say('reasonBlocked')
    case 'working':
    case 'monitoring':
    case 'done':
    case 'idle':
    case 'unverifiable':
      // `unverifiable`'s state word already says it.
      return null
  }
}

/** A count and its state ("2 agents waiting"), one whole sentence per state so a language can
 *  agree the state with the count. */
export function backgroundTaskCountedState(
  counted: string | number,
  state: RunState,
  say: BackgroundTaskSay
): string {
  const value = { value0: counted }
  switch (state) {
    case 'working':
      return say('stateWorkingCount', value)
    case 'monitoring':
      return say('stateMonitoringCount', value)
    case 'waiting':
      return say('stateWaitingCount', value)
    case 'blocked':
      return say('stateBlockedCount', value)
    case 'done':
      return say('stateDoneCount', value)
    case 'idle':
      return say('stateIdleCount', value)
    case 'unverifiable':
      return say('stateUnverifiableCount', value)
  }
}

export function backgroundTaskGroupLabel(kind: TaskKind, say: BackgroundTaskSay): string {
  switch (kind) {
    case 'agent':
      return say('groupAgents')
    case 'command':
      return say('groupShell')
    case 'monitor':
      return say('groupMonitors')
    case 'workflow':
      return say('groupWorkflows')
    case 'unknown':
      return say('groupTasks')
  }
}

function tokenScaleText(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)
}

/** Compact token meta per the mock ("18.2k"). Locale-neutral on purpose:
 *  it sits in a mono meta slot beside elapsed, like other technical literals. */
export function formatBackgroundTaskTokens(totalTokens: number): string {
  if (totalTokens < 1_000) {
    return String(totalTokens)
  }
  // Round before picking the unit, or 999_950 renders as "1000k" instead of "1m".
  const thousands = Math.round(totalTokens / 100) / 10
  return thousands < 1_000
    ? `${tokenScaleText(thousands)}k`
    : `${tokenScaleText(Math.round(totalTokens / 100_000) / 10)}m`
}

export function backgroundTaskElapsedLabel(startedAt: number, now: number): string | null {
  if (startedAt <= 0) {
    return null
  }
  return formatNativeChatDuration((now - startedAt) / 1000)
}

/** Whether a row's elapsed time moves: only live work's does. */
export function backgroundTaskRowTicks(row: AgentChildRowModel): boolean {
  return !row.settled && row.firstObservedAt > 0
}

function rowsTick(rows: readonly AgentChildRowModel[]): boolean {
  return rows.some((row) => backgroundTaskRowTicks(row) || rowsTick(row.owned))
}

/** Whether the strip needs a 1 Hz clock: some live row's elapsed moves, and it shows, because the
 *  list is open or the collapsed header times one live shell. Finished work never wakes it. */
export function backgroundTasksStripTicks(
  groups: readonly BackgroundTaskGroup[],
  expanded: boolean
): boolean {
  const singleLiveCommand =
    groups.length === 1 && groups[0].kind === 'command' && groups[0].tasks.length === 1
  const ticks = groups.some((group) => rowsTick(group.tasks.map((entry) => entry.row)))
  return ticks && (expanded || singleLiveCommand)
}

/** A live row's clock runs; a settled row's stops where it settled, so finished work never ticks. */
export function backgroundTaskRowElapsedLabel(row: AgentChildRowModel, now: number): string | null {
  if (!row.settled) {
    return backgroundTaskElapsedLabel(row.firstObservedAt, now)
  }
  return row.settledAt !== undefined
    ? backgroundTaskElapsedLabel(row.firstObservedAt, row.settledAt)
    : null
}

/** The row's meta slot: tokens, then elapsed. '' when it has neither. */
export function backgroundTaskRowMeta(row: AgentChildRowModel, now: number): string {
  return [
    row.totalTokens !== undefined ? formatBackgroundTaskTokens(row.totalTokens) : null,
    backgroundTaskRowElapsedLabel(row, now)
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
}

/** The provider id a row's Stop targets, or null when the row offers none. Only an explicit `false`
 *  withholds it: a Stop on a row the host cannot target resolves to an empty list and silently
 *  reports nothing cancelled. */
export function backgroundTaskRowStopId(
  row: AgentChildRowModel,
  supportsTaskStop: boolean
): string | null {
  return !row.settled && supportsTaskStop && row.canStop ? (row.providerId ?? null) : null
}
