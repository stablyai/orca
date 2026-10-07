// Desktop words for the background-tasks strip: each shared piece translated whole, with the
// shared English as its fallback, so desktop and the phone never word one roster differently.

import { translate } from '@/i18n/i18n'
import {
  BACKGROUND_TASK_COPY as COPY,
  type BackgroundTaskCopyId,
  type BackgroundTaskCopyValues,
  type BackgroundTaskSay
} from '../../../../shared/background-task-copy'

const PIECES: Record<BackgroundTaskCopyId, (values?: BackgroundTaskCopyValues) => string> = {
  monitoring: () => translate('components.native-chat.backgroundTasks.monitoring', COPY.monitoring),
  stop: () => translate('components.native-chat.backgroundTasks.stop', COPY.stop),
  stopTask: (values) =>
    translate('components.native-chat.backgroundTasks.stopTask', COPY.stopTask, values),
  stopAll: () => translate('components.native-chat.backgroundTasks.stopAll', COPY.stopAll),
  agent: () => translate('components.native-chat.backgroundTasks.agent', COPY.agent),
  workflow: () => translate('components.native-chat.backgroundTasks.workflow', COPY.workflow),
  command: () => translate('components.native-chat.backgroundTasks.command', COPY.command),
  monitor: () => translate('components.native-chat.backgroundTasks.monitor', COPY.monitor),
  task: () => translate('components.native-chat.backgroundTasks.task', COPY.task),
  detailsUnavailable: () =>
    translate('components.native-chat.backgroundTasks.detailsUnavailable', COPY.detailsUnavailable),
  countAgentsOne: () =>
    translate('components.native-chat.backgroundTasks.countAgentsOne', COPY.countAgentsOne),
  countAgentsMany: (values) =>
    translate(
      'components.native-chat.backgroundTasks.countAgentsMany',
      COPY.countAgentsMany,
      values
    ),
  countShellOne: () =>
    translate('components.native-chat.backgroundTasks.countShellOne', COPY.countShellOne),
  countShellMany: (values) =>
    translate('components.native-chat.backgroundTasks.countShellMany', COPY.countShellMany, values),
  countShellCommandOne: () =>
    translate(
      'components.native-chat.backgroundTasks.countShellCommandOne',
      COPY.countShellCommandOne
    ),
  countMonitorsOne: () =>
    translate('components.native-chat.backgroundTasks.countMonitorsOne', COPY.countMonitorsOne),
  countMonitorsMany: (values) =>
    translate(
      'components.native-chat.backgroundTasks.countMonitorsMany',
      COPY.countMonitorsMany,
      values
    ),
  countWorkflowsOne: () =>
    translate('components.native-chat.backgroundTasks.countWorkflowsOne', COPY.countWorkflowsOne),
  countWorkflowsMany: (values) =>
    translate(
      'components.native-chat.backgroundTasks.countWorkflowsMany',
      COPY.countWorkflowsMany,
      values
    ),
  countTasksOne: () =>
    translate('components.native-chat.backgroundTasks.countTasksOne', COPY.countTasksOne),
  countTasksMany: (values) =>
    translate('components.native-chat.backgroundTasks.countTasksMany', COPY.countTasksMany, values),
  headerTotal: (values) =>
    translate('components.native-chat.backgroundTasks.headerTotal', COPY.headerTotal, values),
  stateWorking: () =>
    translate('components.native-chat.backgroundTasks.stateWorking', COPY.stateWorking),
  stateWorkingCount: (values) =>
    translate(
      'components.native-chat.backgroundTasks.stateWorkingCount',
      COPY.stateWorkingCount,
      values
    ),
  stateMonitoring: () =>
    translate('components.native-chat.backgroundTasks.stateMonitoring', COPY.stateMonitoring),
  stateMonitoringCount: (values) =>
    translate(
      'components.native-chat.backgroundTasks.stateMonitoringCount',
      COPY.stateMonitoringCount,
      values
    ),
  stateWaiting: () =>
    translate('components.native-chat.backgroundTasks.stateWaiting', COPY.stateWaiting),
  stateWaitingCount: (values) =>
    translate(
      'components.native-chat.backgroundTasks.stateWaitingCount',
      COPY.stateWaitingCount,
      values
    ),
  stateBlocked: () =>
    translate('components.native-chat.backgroundTasks.stateBlocked', COPY.stateBlocked),
  stateBlockedCount: (values) =>
    translate(
      'components.native-chat.backgroundTasks.stateBlockedCount',
      COPY.stateBlockedCount,
      values
    ),
  stateDone: () => translate('components.native-chat.backgroundTasks.stateDone', COPY.stateDone),
  stateDoneCount: (values) =>
    translate('components.native-chat.backgroundTasks.stateDoneCount', COPY.stateDoneCount, values),
  stateIdle: () => translate('components.native-chat.backgroundTasks.stateIdle', COPY.stateIdle),
  stateIdleCount: (values) =>
    translate('components.native-chat.backgroundTasks.stateIdleCount', COPY.stateIdleCount, values),
  stateUnverifiable: () =>
    translate('components.native-chat.backgroundTasks.stateUnverifiable', COPY.stateUnverifiable),
  stateUnverifiableCount: (values) =>
    translate(
      'components.native-chat.backgroundTasks.stateUnverifiableCount',
      COPY.stateUnverifiableCount,
      values
    ),
  reasonWaiting: () =>
    translate('components.native-chat.backgroundTasks.reasonWaiting', COPY.reasonWaiting),
  reasonBlocked: () =>
    translate('components.native-chat.backgroundTasks.reasonBlocked', COPY.reasonBlocked),
  groupAgents: () =>
    translate('components.native-chat.backgroundTasks.groupAgents', COPY.groupAgents),
  groupShell: () => translate('components.native-chat.backgroundTasks.groupShell', COPY.groupShell),
  groupMonitors: () =>
    translate('components.native-chat.backgroundTasks.groupMonitors', COPY.groupMonitors),
  groupWorkflows: () =>
    translate('components.native-chat.backgroundTasks.groupWorkflows', COPY.groupWorkflows),
  groupTasks: () => translate('components.native-chat.backgroundTasks.groupTasks', COPY.groupTasks)
}

export const sayBackgroundTaskTranslated: BackgroundTaskSay = (id, values) => PIECES[id](values)
