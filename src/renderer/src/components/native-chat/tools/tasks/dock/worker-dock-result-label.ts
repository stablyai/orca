import type { Translate } from '@/i18n/use-translate'
import type { WorkerDockResult } from '../../../../../../../shared/orchestration/dock/worker-dock'

export function workerDockResultLabel(
  t: Translate,
  outcome: WorkerDockResult['outcome'] | undefined
): string {
  if (outcome === 'failed') {
    return t('components.native-chat.workerDock.failed', 'Failed')
  }
  if (outcome === 'unexpected') {
    return t('components.native-chat.workerDock.unexpected', 'Stopped unexpectedly')
  }
  if (outcome === 'stopped') {
    return t('components.native-chat.workerDock.stoppedByYou', 'Stopped by you')
  }
  return t('components.native-chat.workerDock.finished', 'Finished')
}
