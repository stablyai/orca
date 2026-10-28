// Localize the shared background-task grouping and state vocabulary.

import type {
  AgentSessionBackgroundTask,
  AgentSessionBackgroundTaskRunState
} from '../../../../shared/agent-session-wire'
import {
  backgroundTaskGroupLabel as groupLabel,
  backgroundTaskStateReason as stateReason,
  backgroundTaskStateWord as stateWord,
  buildBackgroundTaskGroups as buildGroups,
  resolveBackgroundTaskName as resolveName,
  type BackgroundTaskGroup
} from '../../../../shared/background-task-roster'
import { sayBackgroundTaskTranslated as say } from './background-task-words-text'

type TaskKind = AgentSessionBackgroundTask['kind']
type RunState = AgentSessionBackgroundTaskRunState

export function resolveBackgroundTaskName(task: AgentSessionBackgroundTask): string {
  return resolveName(task, say)
}

export function buildBackgroundTaskGroups(
  tasks: readonly AgentSessionBackgroundTask[],
  settledTasks: readonly AgentSessionBackgroundTask[]
): BackgroundTaskGroup[] {
  return buildGroups(tasks, settledTasks, say)
}

export function backgroundTaskStateWord(state: RunState): string {
  return stateWord(state, say)
}

export function backgroundTaskStateReason(state: RunState): string | null {
  return stateReason(state, say)
}

export function backgroundTaskGroupLabel(kind: TaskKind): string {
  return groupLabel(kind, say)
}
