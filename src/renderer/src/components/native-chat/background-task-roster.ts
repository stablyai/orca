// Localize the shared background-task grouping vocabulary.

import type { AgentSessionBackgroundTask } from '../../../../shared/agent-session/agent-session-background-task-wire'
import {
  backgroundTaskGroupLabel as groupLabel,
  buildBackgroundTaskGroups as buildGroups,
  type BackgroundTaskGroup
} from '../../../../shared/background-task-roster'
import { sayBackgroundTaskTranslated as say } from './background-task-words-text'

type TaskKind = AgentSessionBackgroundTask['kind']

export function buildBackgroundTaskGroups(
  tasks: readonly AgentSessionBackgroundTask[],
  settledTasks: readonly AgentSessionBackgroundTask[]
): BackgroundTaskGroup[] {
  return buildGroups(tasks, settledTasks, say)
}

export function backgroundTaskGroupLabel(kind: TaskKind): string {
  return groupLabel(kind, say)
}
