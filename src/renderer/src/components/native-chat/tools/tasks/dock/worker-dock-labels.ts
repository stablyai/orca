import type { Translate } from '@/i18n/use-translate'
import type { WorkerDockEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'

export function workerDockStateLabel(t: Translate, state: WorkerDockEntry['state']): string {
  switch (state) {
    case 'waiting':
    case 'coordinator':
      return t('components.native-chat.workerDock.coordinator', 'Waiting on coordinator')
    case 'starting':
      return t('components.native-chat.workerDock.starting', 'Starting')
    case 'running':
      return t('components.native-chat.workerDock.running', 'Running')
    case 'idle':
      return t('components.native-chat.workerDock.idle', 'Idle')
    case 'saving':
      return t('components.native-chat.workerDock.saving', 'Saving result…')
    case 'failed':
      return t('components.native-chat.workerDock.failed', 'Failed')
    case 'unexpected':
      return t('components.native-chat.workerDock.unexpected', 'Stopped unexpectedly')
    case 'stopping':
      return t('components.native-chat.workerDock.stopping', 'Stopping…')
    case 'unavailable':
      return t('components.native-chat.workerDock.unavailableState', 'Status unavailable')
    case 'needs-you':
      return t('components.native-chat.workerDock.needsYou', 'Waiting on you')
  }
}
export function workerDockKindLabel(t: Translate, kind: string): string {
  switch (kind) {
    case 'worker':
      return t('components.native-chat.workerDock.worker', 'Worker')
    case 'command':
      return t('components.native-chat.workerDock.command', 'Command')
    case 'workflow':
      return t('components.native-chat.workerDock.workflow', 'Workflow')
    case 'monitor':
      return t('components.native-chat.workerDock.monitor', 'Monitor')
    case 'agent':
      return t('components.native-chat.workerDock.agent', 'Agent')
    default:
      return t('components.native-chat.workerDock.task', 'Task')
  }
}
export function workerDockKindCount(t: Translate, kind: string, count: number): string {
  switch (kind) {
    case 'worker':
      return t('components.native-chat.workerDock.workerCount', '{{count}} workers', {
        count,
        defaultValue_one: '{{count}} worker'
      })
    case 'command':
      return t('components.native-chat.workerDock.commandCount', '{{count}} commands', {
        count,
        defaultValue_one: '{{count}} command'
      })
    case 'workflow':
      return t('components.native-chat.workerDock.workflowCount', '{{count}} workflows', {
        count,
        defaultValue_one: '{{count}} workflow'
      })
    case 'monitor':
      return t('components.native-chat.workerDock.monitorCount', '{{count}} monitors', {
        count,
        defaultValue_one: '{{count}} monitor'
      })
    case 'agent':
      return t('components.native-chat.workerDock.agentCount', '{{count}} agents', {
        count,
        defaultValue_one: '{{count}} agent'
      })
    default:
      return t('components.native-chat.workerDock.taskCount', '{{count}} tasks', {
        count,
        defaultValue_one: '{{count}} task'
      })
  }
}

/** The pill and card with no rows: work the provider reports but does not list, or a failed read. */
export function workerDockEmptyCopy(
  t: Translate,
  unlisted: boolean
): { title: string; note: string } {
  return unlisted
    ? {
        title: t('components.native-chat.workerDock.unlisted', 'Background work running'),
        note: t(
          'components.native-chat.workerDock.unlistedDetail',
          'Some background work isn’t listed here'
        )
      }
    : {
        title: t('components.native-chat.workerDock.unread', 'Workers couldn’t load'),
        note: t(
          'components.native-chat.workerDock.unreadDetail',
          'Workers will show here once they load'
        )
      }
}
