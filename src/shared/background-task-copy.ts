// The words of the background-tasks strip, in English. Desktop translates each piece whole with
// this as its fallback; mobile says it as is, so the two never word one roster differently.

export const BACKGROUND_TASK_COPY = {
  monitoring: 'Monitoring background tasks',
  stop: 'Stop',
  stopTask: 'Stop {{value0}}',
  stopAll: 'Stop background tasks',
  agent: 'Background agent',
  workflow: 'Background workflow',
  command: 'Background command',
  monitor: 'Background monitor',
  task: 'Background task',
  detailsUnavailable: 'Task details are unavailable for this session.',
  countAgentsOne: '1 agent',
  countAgentsMany: '{{value0}} agents',
  countShellOne: '1 shell',
  countShellMany: '{{value0}} shells',
  countShellCommandOne: '1 shell command',
  countMonitorsOne: '1 monitor',
  countMonitorsMany: '{{value0}} monitors',
  countWorkflowsOne: '1 workflow',
  countWorkflowsMany: '{{value0}} workflows',
  countTasksOne: '1 task',
  countTasksMany: '{{value0}} tasks',
  headerTotal: '{{value0}} background tasks',
  stateWorking: 'working',
  stateWorkingCount: '{{value0}} working',
  stateMonitoring: 'monitoring',
  stateMonitoringCount: '{{value0}} monitoring',
  stateWaiting: 'waiting',
  stateWaitingCount: '{{value0}} waiting',
  stateBlocked: 'blocked',
  stateBlockedCount: '{{value0}} blocked',
  stateDone: 'done',
  stateDoneCount: '{{value0}} done',
  stateIdle: 'stopped',
  stateIdleCount: '{{value0}} stopped',
  // Settled unknown or out of contact: claims neither an exit nor a coming update.
  stateUnverifiable: 'status unavailable',
  // After a count, "status unavailable" needs a "with".
  stateUnverifiableCount: '{{value0}} with status unavailable',
  reasonWaiting: 'needs approval',
  reasonBlocked: 'failed',
  groupAgents: 'Agents',
  groupShell: 'Shell',
  groupMonitors: 'Monitors',
  groupWorkflows: 'Workflows',
  groupTasks: 'Tasks'
} as const

export type BackgroundTaskCopyId = keyof typeof BACKGROUND_TASK_COPY

/** What a piece's `{{value0}}` stands for: a count, or a phrase already said. */
export type BackgroundTaskCopyValues = { value0: string | number }

/** One piece in the reader's language, its placeholder filled. */
export type BackgroundTaskSay = (
  id: BackgroundTaskCopyId,
  values?: BackgroundTaskCopyValues
) => string

/** Any surface without translations. */
export const sayBackgroundTaskEnglish: BackgroundTaskSay = (id, values) =>
  values === undefined
    ? BACKGROUND_TASK_COPY[id]
    : // A replacer function, so a task's own `$&` is never read as a pattern.
      BACKGROUND_TASK_COPY[id].replaceAll('{{value0}}', () => String(values.value0))
