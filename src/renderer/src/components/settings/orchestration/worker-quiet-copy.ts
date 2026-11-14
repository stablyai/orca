import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function getWorkerQuietTitle(t: Translate = translate): string {
  return t(
    'auto.components.settings.OrchestrationPane.workerQuietTitle',
    'Tell the coordinator when a worker has made no progress for…'
  )
}

export function getWorkerQuietDescription(t: Translate = translate): string {
  return t(
    'auto.components.settings.OrchestrationPane.workerQuietDescription',
    'Notice only. Workers keep running. Waits 4× longer for tools or unavailable progress. Each host uses its own setting.'
  )
}
