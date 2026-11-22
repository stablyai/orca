import type { Translate } from '@/i18n/use-translate'
import { workerDockKindCount } from './worker-dock-labels'
import type { WorkerDockRowView } from './WorkerDockRow'

export function workerDockSummary(
  identities: readonly { id: string; state: WorkerDockRowView['state']; kind?: string }[],
  rows: ReadonlyMap<string, WorkerDockRowView>,
  t: Translate
) {
  const failures = identities.filter(
    (row) => row.state === 'failed' || row.state === 'unexpected'
  ).length
  const needsYou = identities.filter((row) => row.state === 'needs-you').length
  const unavailable = identities.filter((row) => row.state === 'unavailable').length
  const kinds = new Map<string, number>()
  for (const row of identities) {
    const kind = row.kind ?? rows.get(row.id)?.kind ?? 'worker'
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  }
  const mixed = kinds.size > 1
  const total = identities.length
  const count =
    failures === total && failures > 0
      ? t('components.native-chat.workerDock.failedCount', '{{count}} failed', { count: failures })
      : [
          ...(mixed
            ? [
                t('components.native-chat.workerDock.totalCount', '{{count}} total', {
                  count: total
                })
              ]
            : []),
          ...[...kinds].map(([kind, count]) => workerDockKindCount(t, kind, count)),
          ...(needsYou
            ? [
                t('components.native-chat.workerDock.needsYouCount', '{{count}} needs you', {
                  count: needsYou
                })
              ]
            : []),
          ...(failures
            ? [
                t('components.native-chat.workerDock.failedCount', '{{count}} failed', {
                  count: failures
                })
              ]
            : []),
          ...(unavailable
            ? [
                t('components.native-chat.workerDock.unavailableCount', '{{count}} unavailable', {
                  count: unavailable
                })
              ]
            : [])
        ]
          // Each part stays whole, so a narrow header wraps only between parts.
          .map((part) => part.replaceAll(' ', '\u00a0'))
          .join(' · ')
  return { failures, needsYou, mixed, total, count }
}
