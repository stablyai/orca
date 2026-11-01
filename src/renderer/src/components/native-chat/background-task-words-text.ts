// Translate whole shared pieces with shared English fallbacks so desktop and mobile roster wording agree.

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
  countAgents: (values) =>
    translate('components.native-chat.backgroundTasks.countAgents', COPY.countAgents.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.countAgents.one
    }),
  countShell: (values) =>
    translate('components.native-chat.backgroundTasks.countShell', COPY.countShell.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.countShell.one
    }),
  countShellCommandOne: () =>
    translate(
      'components.native-chat.backgroundTasks.countShellCommandOne',
      COPY.countShellCommandOne
    ),
  countMonitors: (values) =>
    translate('components.native-chat.backgroundTasks.countMonitors', COPY.countMonitors.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.countMonitors.one
    }),
  countWorkflows: (values) =>
    translate('components.native-chat.backgroundTasks.countWorkflows', COPY.countWorkflows.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.countWorkflows.one
    }),
  countTasks: (values) =>
    translate('components.native-chat.backgroundTasks.countTasks', COPY.countTasks.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.countTasks.one
    }),
  headerTotal: (values) =>
    translate('components.native-chat.backgroundTasks.headerTotal', COPY.headerTotal.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.headerTotal.one
    }),
  stateWorking: () =>
    translate('components.native-chat.backgroundTasks.stateWorking', COPY.stateWorking),
  stateWorkingCount: (values) =>
    translate(
      'components.native-chat.backgroundTasks.stateWorkingCount',
      COPY.stateWorkingCount.other,
      { ...values, count: values?.count, defaultValue_one: COPY.stateWorkingCount.one }
    ),
  stateMonitoring: () =>
    translate('components.native-chat.backgroundTasks.stateMonitoring', COPY.stateMonitoring),
  stateMonitoringCount: (values) =>
    translate(
      'components.native-chat.backgroundTasks.stateMonitoringCount',
      COPY.stateMonitoringCount.other,
      { ...values, count: values?.count, defaultValue_one: COPY.stateMonitoringCount.one }
    ),
  stateWaiting: () =>
    translate('components.native-chat.backgroundTasks.stateWaiting', COPY.stateWaiting),
  stateWaitingCount: (values) =>
    translate(
      'components.native-chat.backgroundTasks.stateWaitingCount',
      COPY.stateWaitingCount.other,
      { ...values, count: values?.count, defaultValue_one: COPY.stateWaitingCount.one }
    ),
  stateBlocked: () =>
    translate('components.native-chat.backgroundTasks.stateBlocked', COPY.stateBlocked),
  stateBlockedCount: (values) =>
    translate(
      'components.native-chat.backgroundTasks.stateBlockedCount',
      COPY.stateBlockedCount.other,
      { ...values, count: values?.count, defaultValue_one: COPY.stateBlockedCount.one }
    ),
  stateDone: () => translate('components.native-chat.backgroundTasks.stateDone', COPY.stateDone),
  stateDoneCount: (values) =>
    translate('components.native-chat.backgroundTasks.stateDoneCount', COPY.stateDoneCount.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.stateDoneCount.one
    }),
  stateIdle: () => translate('components.native-chat.backgroundTasks.stateIdle', COPY.stateIdle),
  stateIdleCount: (values) =>
    translate('components.native-chat.backgroundTasks.stateIdleCount', COPY.stateIdleCount.other, {
      ...values,
      count: values?.count,
      defaultValue_one: COPY.stateIdleCount.one
    }),
  stateUnverifiable: () =>
    translate('components.native-chat.backgroundTasks.stateUnverifiable', COPY.stateUnverifiable),
  stateUnverifiableCount: (values) =>
    translate(
      'components.native-chat.backgroundTasks.stateUnverifiableCount',
      COPY.stateUnverifiableCount.other,
      { ...values, count: values?.count, defaultValue_one: COPY.stateUnverifiableCount.one }
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
