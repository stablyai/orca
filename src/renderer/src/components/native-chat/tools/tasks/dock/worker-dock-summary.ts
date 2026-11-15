import type { WorkerDockRowView } from './WorkerDockRow'

export function workerDockSummary(
  identities: readonly { id: string; state: WorkerDockRowView['state']; kind?: string }[],
  rows: ReadonlyMap<string, WorkerDockRowView>
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
      ? `${failures} failed`
      : [
          ...(mixed ? [`${total} total`] : []),
          ...[...kinds].map(([kind, count]) => `${count} ${kind}${count === 1 ? '' : 's'}`),
          ...(needsYou ? [`${needsYou} needs you`] : []),
          ...(failures ? [`${failures} failed`] : []),
          ...(unavailable ? [`${unavailable} unavailable`] : [])
        ].join(' · ')
  return { failures, mixed, total, count }
}
