// Grouping, naming, and header derivation for the background-tasks strip.
// Pure functions over the wire roster so every header variant is unit-testable
// without mounting the strip.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from '../../../../shared/agent-session-wire'
import { formatNativeChatDuration } from '../../../../shared/native-chat-turn-status'
import { translate } from '@/i18n/i18n'

type TaskKind = AgentSessionBackgroundTask['kind']
type RunState = AgentSessionBackgroundTaskRunState

export type BackgroundRosterTask = {
  task: AgentSessionBackgroundTask
  settled: boolean
  state: RunState
  name: string
}

export type BackgroundTaskGroup = { kind: TaskKind; tasks: BackgroundRosterTask[] }

/** Fixed presentation order; groups render only when non-empty. */
const KIND_ORDER: readonly TaskKind[] = ['agent', 'command', 'monitor', 'workflow', 'unknown']

/** Provider strings that carry no identity; a row falls through to its kind label. */
const PLACEHOLDER_NAMES = new Set(['unknown', 'untitled', 'task', 'subagent'])

function usableTaskText(value: string | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed || PLACEHOLDER_NAMES.has(trimmed.toLowerCase())) {
    return null
  }
  return trimmed
}

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

/** Display name: description → name → kind label. Empty-after-trim and
 *  placeholder values fall through, so a row always renders something. */
export function resolveBackgroundTaskName(task: AgentSessionBackgroundTask): string {
  return (
    usableTaskText(task.description) ??
    usableTaskText(task.name) ??
    backgroundTaskKindLabel(task.kind)
  )
}

function effectiveState(task: AgentSessionBackgroundTask, settled: boolean): RunState {
  if (task.state) {
    return task.state
  }
  if (settled) {
    return 'done'
  }
  return task.kind === 'monitor' ? 'monitoring' : 'working'
}

/** Merge live and settled tasks into kind groups, stable-sorted first-seen
 *  (startedAt) then id, so a live update never reshuffles surviving rows. */
export function buildBackgroundTaskGroups(
  tasks: readonly AgentSessionBackgroundTask[],
  settledTasks: readonly AgentSessionBackgroundTask[]
): BackgroundTaskGroup[] {
  // Older hosts can retain a previous turn beside its resumed live task.
  const owners = new Map<string, BackgroundRosterTask>()
  for (const [roster, settled] of [
    [settledTasks, true],
    [tasks, false]
  ] as const) {
    for (const task of roster) {
      owners.set(task.id, {
        task,
        settled,
        state: effectiveState(task, settled),
        name: resolveBackgroundTaskName(task)
      })
    }
  }
  const entries = [...owners.values()]
  entries.sort((left, right) => {
    const startDelta = (left.task.startedAt ?? 0) - (right.task.startedAt ?? 0)
    return startDelta !== 0 ? startDelta : left.task.id < right.task.id ? -1 : 1
  })
  return KIND_ORDER.map((kind) => ({
    kind,
    tasks: entries.filter((entry) => entry.task.kind === kind)
  })).filter((group) => group.tasks.length > 0)
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

export function backgroundTaskElapsedLabel(
  task: AgentSessionBackgroundTask,
  now: number
): string | null {
  if (task.startedAt === undefined || task.startedAt <= 0) {
    return null
  }
  return formatNativeChatDuration((now - task.startedAt) / 1000)
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
