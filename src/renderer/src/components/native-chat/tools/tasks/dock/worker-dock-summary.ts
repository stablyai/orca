import type { Translate } from '@/i18n/use-translate'
import {
  workerDockBackgroundCommandCount,
  workerDockCommandCount,
  workerDockIsAgentKind,
  workerDockMixedCount,
  workerDockWorkerCount
} from './worker-dock-labels'
import type { WorkerDockRowView } from './WorkerDockRow'

/** The tray's count in words. `chip` is the short form ("2 workers · 1 command", "1 background
 *  command"); `spoken` always names both in full ("2 workers, 1 background command"). */
export function workerDockCountText(
  t: Translate,
  workers: number,
  commands: number
): { chip: string; spoken: string } {
  if (!workers && !commands) {
    return { chip: '', spoken: '' }
  }
  if (!commands) {
    const text = workerDockWorkerCount(t, workers)
    return { chip: text, spoken: text }
  }
  const background = workerDockBackgroundCommandCount(t, commands)
  if (!workers) {
    return { chip: background, spoken: background }
  }
  const worker = workerDockWorkerCount(t, workers)
  return {
    chip: workerDockMixedCount(t, worker, workerDockCommandCount(t, commands), false),
    spoken: workerDockMixedCount(t, worker, background, true)
  }
}

export function workerDockSummary(
  identities: readonly { id: string; state: WorkerDockRowView['state']; kind?: string }[],
  rows: ReadonlyMap<string, WorkerDockRowView>,
  t: Translate
) {
  let failures = 0
  let needsYou = 0
  let running = 0
  let workers = 0
  const kinds = new Set<string>()
  for (const row of identities) {
    const kind = row.kind ?? rows.get(row.id)?.kind ?? 'worker'
    kinds.add(kind)
    // Only agents count as workers; background commands are counted apart.
    if (workerDockIsAgentKind(kind)) {
      workers++
    }
    if (row.state === 'failed' || row.state === 'unexpected') {
      failures++
    } else if (row.state === 'needs-you') {
      needsYou++
    } else if (row.state === 'running' || row.state === 'starting' || row.state === 'stopping') {
      running++
    }
  }
  // Every listed row, for the all-failed check and whether anything is shown at all.
  const total = identities.length
  const commands = total - workers
  const { chip, spoken } = workerDockCountText(t, workers, commands)
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
    running,
    mixed: kinds.size > 1,
    total,
    workers,
    commands,
    label: chip,
    spoken,
    count: [spoken, status].filter(Boolean).join(' · ')
  }
}

/** The chip's text, never empty: a lone worker's title (folded; open, its row shows the title),
 *  what needs the user ("1 needs you · 4 workers"), what runs among workers alone ("3 running"),
 *  or the count ("3 workers", "2 workers · 1 command", "1 background command"), or the empty copy
 *  with no rows. A held roster can outlive
 *  its live count by a gesture, so it then counts its own rows. */
export function workerDockChipLabel(
  t: Translate,
  {
    summary,
    rows,
    empty,
    single,
    open
  }: {
    summary: {
      total: number
      failures: number
      needsYou: number
      running: number
      commands: number
      label: string
    }
    rows: { workers: number; commands: number }
    empty: string | null
    /** The title of the only listed row, when it is one worker (a lone command is still counted). */
    single: string | null
    open: boolean
  }
): string {
  if (empty !== null) {
    return empty
  }
  if (single !== null && !open && (summary.total || rows.workers + rows.commands) === 1) {
    return single
  }
  if (!summary.total) {
    return workerDockCountText(t, rows.workers, rows.commands).chip
  }
  if (summary.failures === summary.total) {
    return t('components.native-chat.workerDock.failedCount', '{{count}} failed', {
      count: summary.failures
    })
  }
  const attention = summary.failures + summary.needsYou
  if (attention) {
    return [
      t('components.native-chat.workerDock.needsYouCount', '{{count}} needs you', {
        count: attention
      }),
      summary.label
    ].join(' · ')
  }
  // With background commands listed, the count names them apart from the workers instead.
  return summary.running && !summary.commands
    ? t('components.native-chat.workerDock.runningCount', '{{count}} running', {
        count: summary.running
      })
    : summary.label
}

/** The counts that name the card (header, region, chip glyph, spoken chip, pill total). A held
 *  roster can outlive its live count by a gesture; they then read the rows it still shows, while
 *  live failure and status words stay as reported. */
export function workerDockNamedCounts(
  t: Translate,
  summary: ReturnType<typeof workerDockSummary>,
  held: { workers: number; commands: number }
): ReturnType<typeof workerDockSummary> {
  if (summary.total) {
    return summary
  }
  const text = workerDockCountText(t, held.workers, held.commands)
  return {
    ...summary,
    ...held,
    total: held.workers + held.commands,
    label: text.chip,
    spoken: text.spoken
  }
}

/** The chip's text, its spoken form (the counts at its end name both groups in full: "2 workers, 1
 *  background command"), whether it is a worker's own title, and the counts that name the card. */
export function workerDockChip(
  t: Translate,
  input: Omit<Parameters<typeof workerDockChipLabel>[1], 'summary'> & {
    summary: ReturnType<typeof workerDockSummary>
  }
): { label: string; spoken: string; titled: boolean; named: ReturnType<typeof workerDockSummary> } {
  const label = workerDockChipLabel(t, input)
  const named = workerDockNamedCounts(t, input.summary, input.rows)
  const spoken =
    named.spoken && label.endsWith(named.label)
      ? label.slice(0, label.length - named.label.length) + named.spoken
      : label
  return { label, spoken, titled: label === input.single, named }
}
