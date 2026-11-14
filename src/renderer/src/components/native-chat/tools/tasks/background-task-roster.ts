// Localize the shared background-task grouping vocabulary.

import type { AgentSessionBackgroundTask } from '../../../../../../shared/agent-session/agent-session-background-task-wire'
import type { AgentChildRowContext } from '../../../../../../shared/agent-status/presentation/agent-child-row-model'
import type { AgentChildWorkView } from '../../../../../../shared/agent-status/child-work/agent-status-child-work-view'
import {
  backgroundTaskGroupLabel as groupLabel,
  buildBackgroundTaskGroups as buildGroups,
  buildBackgroundTaskGroupsFromViews,
  type BackgroundTaskGroup
} from '../../../../../../shared/background-task-roster'
import { sayBackgroundTaskTranslated as say } from './background-task-words-text'

type TaskKind = AgentSessionBackgroundTask['kind']

export function buildBackgroundTaskGroups(
  tasks: readonly AgentSessionBackgroundTask[],
  settledTasks: readonly AgentSessionBackgroundTask[]
): BackgroundTaskGroup[] {
  return buildGroups(tasks, settledTasks, say)
}

/** The strip's rows: the host's child views when it publishes them, else its task roster. */
export function structuredSessionBackgroundTaskGroups(
  tasks: readonly AgentSessionBackgroundTask[],
  settledTasks: readonly AgentSessionBackgroundTask[],
  childViews: readonly AgentChildWorkView[] | undefined,
  childRowContext: AgentChildRowContext | undefined
): BackgroundTaskGroup[] {
  return childViews !== undefined
    ? buildBackgroundTaskGroupsFromViews(childViews, childRowContext)
    : buildBackgroundTaskGroups(tasks, settledTasks)
}

export function backgroundTaskGroupLabel(kind: TaskKind): string {
  return groupLabel(kind, say)
}
