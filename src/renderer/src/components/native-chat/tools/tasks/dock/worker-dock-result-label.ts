import type { WorkerDockResult } from '../../../../../../../shared/orchestration/dock/worker-dock'

export function workerDockResultLabel(outcome: WorkerDockResult['outcome'] | undefined): string {
  if (outcome === 'failed') {
    return 'Failed'
  }
  if (outcome === 'unexpected') {
    return 'Stopped unexpectedly'
  }
  if (outcome === 'stopped') {
    return 'Stopped by you'
  }
  return 'Finished'
}
