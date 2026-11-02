// Share whole English translation pieces for desktop/mobile roster wording.

import { englishCopyText, type CopyValues, type CountedCopy } from './counted-copy-english'

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
  countAgents: { one: '{{count}} agent', other: '{{count}} agents' },
  countShell: { one: '{{count}} shell', other: '{{count}} shells' },
  countShellCommandOne: '1 shell command',
  countMonitors: { one: '{{count}} monitor', other: '{{count}} monitors' },
  countWorkflows: { one: '{{count}} workflow', other: '{{count}} workflows' },
  countTasks: { one: '{{count}} task', other: '{{count}} tasks' },
  headerTotal: { one: '{{count}} background task', other: '{{count}} background tasks' },
  stateWorking: 'working',
  stateWorkingCount: { one: '{{value0}} working', other: '{{value0}} working' },
  stateMonitoring: 'monitoring',
  stateMonitoringCount: { one: '{{value0}} monitoring', other: '{{value0}} monitoring' },
  stateWaiting: 'waiting',
  stateWaitingCount: { one: '{{value0}} waiting', other: '{{value0}} waiting' },
  stateBlocked: 'blocked',
  stateBlockedCount: { one: '{{value0}} blocked', other: '{{value0}} blocked' },
  stateDone: 'done',
  stateDoneCount: { one: '{{value0}} done', other: '{{value0}} done' },
  stateIdle: 'stopped',
  stateIdleCount: { one: '{{value0}} stopped', other: '{{value0}} stopped' },
  // Settled unknown or out of contact: claims neither an exit nor a coming update.
  stateUnverifiable: 'status unavailable',
  // After a count, "status unavailable" needs a "with".
  stateUnverifiableCount: {
    one: '{{value0}} with status unavailable',
    other: '{{value0}} with status unavailable'
  },
  reasonWaiting: 'needs approval',
  reasonBlocked: 'failed',
  groupAgents: 'Agents',
  groupShell: 'Shell',
  groupMonitors: 'Monitors',
  groupWorkflows: 'Workflows',
  groupTasks: 'Tasks'
} as const satisfies Record<string, string | CountedCopy>

export type BackgroundTaskCopyId = keyof typeof BACKGROUND_TASK_COPY

/** Counted pieces need `count`; `value0` is the counted phrase or number the state describes. */
export type BackgroundTaskCopyValues = CopyValues

/** One piece in the reader's language, its placeholders filled. */
export type BackgroundTaskSay = (
  id: BackgroundTaskCopyId,
  values?: BackgroundTaskCopyValues
) => string

/** Any surface without translations. */
export const sayBackgroundTaskEnglish: BackgroundTaskSay = (id, values) =>
  englishCopyText(BACKGROUND_TASK_COPY[id], values)
