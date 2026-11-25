import type { Translate } from '@/i18n/use-translate'
import { workerDockKindCount } from './worker-dock-labels'
import type { WorkerDockRowView } from './WorkerDockRow'

export function workerDockSummary(
  identities: readonly { id: string; state: WorkerDockRowView['state']; kind?: string }[],
  rows: ReadonlyMap<string, WorkerDockRowView>,
  t: Translate
) {
  let failures = 0
  let needsYou = 0
  let running = 0
  const kinds = new Map<string, number>()
  for (const row of identities) {
    const kind = row.kind ?? rows.get(row.id)?.kind ?? 'worker'
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
    if (row.state === 'failed' || row.state === 'unexpected') {
      failures++
    } else if (row.state === 'needs-you') {
      needsYou++
    } else if (row.state === 'running' || row.state === 'starting' || row.state === 'stopping') {
      running++
    }
  }
  const total = identities.length
  const workers = kinds.get('worker')
  const onlyKind = kinds.size === 1 ? kinds.keys().next().value : undefined
  const countLabel = total
    ? workerDockKindCount(t, workers ? 'worker' : (onlyKind ?? 'task'), workers ?? total)
    : ''
  const status = failures
    ? t('components.native-chat.workerDock.failedCount', '{{count}} failed', { count: failures })
    : needsYou
      ? t('components.native-chat.workerDock.needsYouCount', '{{count}} needs you', {
          count: needsYou
        })
      : running
        ? t('components.native-chat.workerDock.runningCount', '{{count}} running', {
            count: running
          })
        : ''
  return {
    failures,
    needsYou,
    mixed: kinds.size > 1,
    total,
    label: countLabel,
    count: [countLabel, status].filter(Boolean).join(' · ')
  }
}
