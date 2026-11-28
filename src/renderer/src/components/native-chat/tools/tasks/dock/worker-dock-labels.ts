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
/** Agents count as workers: orchestration workers (whose identities carry no kind) and subagents.
 *  Commands, monitors, workflows (whose agents are listed on their own) and unclassified tasks are
 *  background work, listed in their own group and never counted as workers. */
export function workerDockIsAgentKind(kind: string | undefined): boolean {
  return kind === undefined || kind === 'worker' || kind === 'agent'
}

/** "1 worker", "3 workers": agents only. */
export function workerDockWorkerCount(t: Translate, count: number): string {
  return t('components.native-chat.workerDock.workerCount', '{{count}} workers', {
    count,
    defaultValue_one: '{{count}} worker'
  })
}

/** "1 background command": the chip when only commands are listed, and the spoken count. */
export function workerDockBackgroundCommandCount(t: Translate, count: number): string {
  return t(
    'components.native-chat.workerDock.backgroundCommandCount',
    '{{count}} background commands',
    {
      count,
      defaultValue_one: '{{count}} background command'
    }
  )
}

/** "1 command": beside a worker count, which already says what the tray holds. */
export function workerDockCommandCount(t: Translate, count: number): string {
  return t('components.native-chat.workerDock.commandCount', '{{count}} commands', {
    count,
    defaultValue_one: '{{count}} command'
  })
}

/** Both counts as one message, so a language can order and join them its own way. */
export function workerDockMixedCount(
  t: Translate,
  workers: string,
  commands: string,
  spoken: boolean
): string {
  return spoken
    ? t('components.native-chat.workerDock.mixedCountSpoken', '{{workers}}, {{commands}}', {
        workers,
        commands
      })
    : t('components.native-chat.workerDock.mixedCount', '{{workers}} · {{commands}}', {
        workers,
        commands
      })
}

export function workerDockRegionLabel(t: Translate, workers: number, commands: number): string {
  return workers && commands
    ? t('components.native-chat.workerDock.mixedRegion', 'Workers and background commands')
    : commands
      ? t('components.native-chat.workerDock.commandsRegion', 'Background commands')
      : t('components.native-chat.workerDock.workersRegion', 'Workers')
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

// A command line read aloud stops here; the details dialog keeps all of it.
const SPOKEN_COMMAND_MAX = 60

/** A row's title as assistive technology hears it, wherever it is spoken (the row, its Stop, the
 *  chip's "latest"): a command line is cut near 60 characters. */
export function workerDockSpokenTitle(kind: string | undefined, title: string): string {
  return kind === 'command' && title.length > SPOKEN_COMMAND_MAX
    ? `${title.slice(0, SPOKEN_COMMAND_MAX - 1).trimEnd()}…`
    : title
}
