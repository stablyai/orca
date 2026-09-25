// Grouping, naming, and header derivation for the background-tasks strip.
// Pure functions over the wire roster so every header variant is unit-testable
// without mounting the strip.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from '../../../../shared/agent-session-wire'
import {
  buildAgentChildRowModels,
  buildLegacyTaskRowModels,
  usableAgentChildLabel,
  type AgentChildRowContext,
  type AgentChildRowModel
} from '../../../../shared/agent-child-row-model'
import { agentChildRunStateFor } from '../../../../shared/agent-status-child-work-display'
import type { AgentChildWorkView } from '../../../../shared/agent-status-child-work-view'
import { formatNativeChatDuration } from '../../../../shared/native-chat-turn-status'
import { translate } from '@/i18n/i18n'

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

export function backgroundTaskKindLabel(kind: TaskKind): string {
  switch (kind) {
    case 'agent':
      return translate('components.native-chat.backgroundTasks.agent', 'Background agent')
    case 'workflow':
      return translate('components.native-chat.backgroundTasks.workflow', 'Background workflow')
    case 'command':
      return translate('components.native-chat.backgroundTasks.command', 'Background command')
    case 'monitor':
      return translate('components.native-chat.backgroundTasks.monitor', 'Background monitor')
    case 'unknown':
      return translate('components.native-chat.backgroundTasks.task', 'Background task')
  }
}

/** The transcript row's name: description → name → kind label. Empty-after-trim and
 *  placeholder values fall through, so the row always renders something. */
export function resolveBackgroundTaskName(task: AgentSessionBackgroundTask): string {
  return (
    usableAgentChildLabel(task.description) ??
    usableAgentChildLabel(task.name) ??
    backgroundTaskKindLabel(task.kind)
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
  settledTasks: readonly AgentSessionBackgroundTask[]
): BackgroundTaskGroup[] {
  // An old host's unlabeled row keeps the kind label it always showed; a view row reads its state.
  return rosterEntries(
    buildLegacyTaskRowModels(tasks, settledTasks).map((row) =>
      row.name ? row : { ...row, name: backgroundTaskKindLabel(row.kind) }
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

export function backgroundTaskStateWord(state: RunState): string {
  switch (state) {
    case 'working':
      return translate('components.native-chat.backgroundTasks.stateWorking', 'working')
    case 'monitoring':
      return translate('components.native-chat.backgroundTasks.stateMonitoring', 'monitoring')
    case 'waiting':
      return translate('components.native-chat.backgroundTasks.stateWaiting', 'waiting')
    case 'blocked':
      return translate('components.native-chat.backgroundTasks.stateBlocked', 'blocked')
    case 'done':
      return translate('components.native-chat.backgroundTasks.stateDone', 'done')
    case 'idle':
      return translate('components.native-chat.backgroundTasks.stateIdle', 'stopped')
    case 'unverifiable':
      return translate('components.native-chat.backgroundTasks.stateUnverifiable', 'unverifiable')
  }
}

/** The reason line for an attention state, per the signed-off mock. */
export function backgroundTaskStateReason(state: RunState): string | null {
  switch (state) {
    case 'waiting':
      return translate('components.native-chat.backgroundTasks.reasonWaiting', 'needs approval')
    case 'unverifiable':
      return translate('components.native-chat.backgroundTasks.reasonUnverifiable', 'no contact')
    case 'blocked':
      return translate('components.native-chat.backgroundTasks.reasonBlocked', 'failed')
    case 'working':
    case 'monitoring':
    case 'done':
    case 'idle':
      return null
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

/** A live row's clock runs; a settled row's stops where it settled, so finished work never ticks. */
export function backgroundTaskRowElapsedLabel(row: AgentChildRowModel, now: number): string | null {
  if (!row.settled) {
    return backgroundTaskElapsedLabel(row.firstObservedAt, now)
  }
  return row.settledAt !== undefined
    ? backgroundTaskElapsedLabel(row.firstObservedAt, row.settledAt)
    : null
}

export function backgroundTaskGroupLabel(kind: TaskKind): string {
  switch (kind) {
    case 'agent':
      return translate('components.native-chat.backgroundTasks.groupAgents', 'Agents')
    case 'command':
      return translate('components.native-chat.backgroundTasks.groupShell', 'Shell')
    case 'monitor':
      return translate('components.native-chat.backgroundTasks.groupMonitors', 'Monitors')
    case 'workflow':
      return translate('components.native-chat.backgroundTasks.groupWorkflows', 'Workflows')
    case 'unknown':
      return translate('components.native-chat.backgroundTasks.groupTasks', 'Tasks')
  }
}
