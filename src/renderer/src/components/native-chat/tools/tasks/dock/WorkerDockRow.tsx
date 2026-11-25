import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { workerDockKindLabel, workerDockStateLabel } from './worker-dock-labels'
import { memo } from 'react'
import { cn } from '@/lib/class-names'
import { WorkerDockRowAction } from './WorkerDockRowAction'
import { WorkerDockGlyph } from './WorkerDockGlyph'
import { workerDockGlyph } from './worker-dock-card-order'
import { useNowSnapshot } from '@/lib/window-activity/use-now'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import type { WorkerDockEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'

export type WorkerDockRowView = WorkerDockEntry & {
  retired?: boolean
  providerId?: string
  /** The open question a needs-you worker asked: the row's title while it waits. */
  question?: string
}

/** What a row and the pill call the worker: its question while it waits on you, else its title
 *  once (the ticket name stays in the tooltip, so it is never repeated in front of the title). */
export function workerDockRowTitle(row: WorkerDockRowView): string {
  return (row.state === 'needs-you' && row.question) || row.title || row.name
}

function Age({ at, visible }: { at: number | null; visible: boolean }) {
  const locale = useIntlLocale()
  const label = useNowSnapshot(
    30_000,
    (now) => (at === null ? '' : formatShortTimeAgo(at, now)),
    visible && at !== null
  )
  return at === null ? null : (
    <span className="tabular-nums" title={new Date(at).toLocaleString(locale)}>
      {label}
    </span>
  )
}

/** One panel row: status mark and the full title, then kind, model and time; on hover or
 *  focus Stop or Clear cover the row's end.
 *  The open button stretches over the whole row, so a press anywhere but the action opens it. A row
 *  whose details have not arrived yet keeps the same button, so focus on it survives their arrival. */
export const WorkerDockRow = memo(function WorkerDockRow({
  id,
  row,
  mixed,
  visible,
  pending,
  onOpen,
  onAction
}: {
  /** The identity's id, for a row whose details are still loading. */
  id?: string
  row: WorkerDockRowView | undefined
  mixed: boolean
  visible: boolean
  pending: boolean
  onOpen: (row: WorkerDockRowView, opener: HTMLElement) => void
  onAction: (row: WorkerDockRowView, action: 'stop' | 'clear') => void
}) {
  const t = useTranslate()
  const rowId = row?.id ?? id ?? ''
  const loading = t('components.native-chat.workerDock.loadingWorker', 'Loading worker…')
  const title = row ? workerDockRowTitle(row) : loading
  const kind = row ? workerDockKindLabel(t, row.kind) : ''
  // An unreadable state has no status label.
  const state = !row
    ? ''
    : row.retired
      ? t('components.native-chat.workerDock.doneResult', 'Done · open result')
      : row.state === 'unavailable'
        ? ''
        : workerDockStateLabel(t, row.state)
  // A remote chat's worker is shown, not driven, here: its label says where to act instead.
  const remote =
    row?.kind === 'worker' && row.ownerActionsAvailable === false
      ? t(
          'components.native-chat.workerDock.remoteOwner',
          'Stop or clear this from the computer it runs on'
        )
      : ''
  const reason =
    row &&
    (row.state === 'failed' || row.state === 'unexpected' || row.state === 'stopping') &&
    row.reason
      ? row.reason
      : ''
  const label = [mixed ? kind : '', title, state, reason, remote].filter(Boolean).join(' · ')
  const tooltip = row
    ? [kind, row.name, title === row.title ? '' : row.title, title, state, reason, remote]
        .filter(Boolean)
        .join(' · ')
    : undefined
  return (
    <div
      data-worker-dock-row={rowId}
      data-worker-dock-state={row?.state ?? 'loading'}
      className="group/worker relative flex min-w-0 rounded-md pr-2 text-foreground hover:bg-accent has-focus-visible:bg-accent"
    >
      <button
        type="button"
        data-worker-dock-open={rowId}
        aria-label={label}
        aria-disabled={row ? undefined : true}
        title={tooltip}
        className="flex min-w-0 flex-1 items-start gap-2 py-0.5 pl-2 text-left text-sm after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring aria-disabled:text-muted-foreground"
        onClick={(event) => {
          if (row) {
            onOpen(row, event.currentTarget)
          }
        }}
      >
        <span className="flex h-5 shrink-0 items-center">
          <WorkerDockGlyph glyph={row ? workerDockGlyph(row) : 'queued'} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="line-clamp-3 break-words">{title}</span>
          {row ? (
            <span className="truncate text-xs text-muted-foreground">
              {kind}
              {row.model ? ` · ${row.model}` : null}
              {row.changedAt !== null ? ' · ' : null}
              <Age at={row.changedAt} visible={visible} />
            </span>
          ) : null}
        </span>
      </button>
      {/* Over the row's end on hover or focus, so at rest the title has the row's whole width. At rest it
          is transparent and takes no presses (a press there opens the row), but stays in the
          accessibility tree and the tab order; focus inside the row shows it. */}
      <div
        data-worker-dock-hover=""
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 flex items-center gap-1 rounded-r-md bg-accent pr-2 pl-1.5',
          pending
            ? 'opacity-100 [&>*]:pointer-events-auto'
            : 'opacity-0 group-hover/worker:opacity-100 group-hover/worker:[&>*:not(svg)]:pointer-events-auto group-focus-within/worker:opacity-100 [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:[&>*:not(svg)]:pointer-events-auto'
        )}
      >
        {row ? <WorkerDockRowAction row={row} pending={pending} onAction={onAction} /> : null}
      </div>
    </div>
  )
})
