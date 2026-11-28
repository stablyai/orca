import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  workerDockKindLabel,
  workerDockSpokenTitle,
  workerDockStateLabel
} from './worker-dock-labels'
import { memo } from 'react'
import { cn } from '@/lib/class-names'
import { WorkerDockRowAction } from './WorkerDockRowAction'
import { WorkerDockGlyph } from './WorkerDockGlyph'
import { workerDockGlyph } from './worker-dock-card-order'
import { useNowSnapshot } from '@/lib/window-activity/use-now'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import {
  NativeChatEventIcon,
  type NativeChatEventBadge
} from '../../../messages/events/NativeChatEventRow'
import { AgentTypeIcon } from '@/components/agent/icons/agent-type-icon'
import type { WorkerDockEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'
import type { AgentType } from '../../../../../../../shared/agent-status/contracts/agent-status-types'
import { formatAgentTypeLabel } from '../../../../../../../shared/agent-status/presentation/agent-type-label'

export type WorkerDockRowView = WorkerDockEntry & {
  retired?: boolean
  providerId?: string
  /** The open question a needs-you worker asked: the row's title while it waits. */
  question?: string
}

/** What a row and the pill call the worker: its question while it waits on you, else its title. */
export function workerDockRowTitle(row: WorkerDockRowView): string {
  return (row.state === 'needs-you' && row.question) || row.title || row.name
}

function workerDockBadge(row: WorkerDockRowView | undefined): NativeChatEventBadge | null {
  switch (row && workerDockGlyph(row)) {
    case 'ask':
      return 'needs-input'
    case 'running':
      return 'running'
    case 'failed':
      return 'failed'
    case 'queued':
      return 'queued'
    case 'done':
      return 'done'
    case undefined:
      return null
  }
}

function workerDockAgentLabel(agent: AgentType | null | undefined): string {
  return formatAgentTypeLabel(agent)
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

/** One panel row on one line: status mark, title and age; on hover or focus Stop or Clear cover
 *  the row's end.
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
  // An unreadable state has no label anywhere: the row reads as its title and time only.
  const state = !row || row.state === 'unavailable' ? '' : workerDockStateLabel(t, row.state)
  // A remote chat's worker is shown, not driven, here: its label says where to act instead.
  const remote =
    row?.kind === 'worker' && row.ownerActionsAvailable === false
      ? t(
          'components.native-chat.workerDock.remoteOwner',
          'Stop or clear this from the computer it runs on'
        )
      : ''
  const progress =
    row &&
    !row.retired &&
    row.state !== 'failed' &&
    row.state !== 'unexpected' &&
    row.state !== 'stopping' &&
    row.progressNote
      ? row.progressNote
      : ''
  const label = [
    mixed && row ? workerDockKindLabel(t, row.kind) : '',
    row ? workerDockSpokenTitle(row.kind, title) : title,
    row?.kind === 'worker' ? workerDockAgentLabel(row.agent) : '',
    state,
    progress,
    remote
  ]
    .filter(Boolean)
    .join(' · ')
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
        className="flex h-8 min-w-0 flex-1 items-center gap-2 pl-2 text-left text-sm whitespace-nowrap after:absolute after:inset-0 after:rounded-md focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring aria-disabled:text-muted-foreground"
        onClick={(event) => {
          if (row) {
            onOpen(row, event.currentTarget)
          }
        }}
      >
        <span className="flex h-5 w-3 shrink-0 items-center justify-center">
          {row?.kind === 'worker' ? (
            <NativeChatEventIcon
              badge={workerDockBadge(row)}
              badgeClassName="group-hover/worker:bg-accent group-focus-within/worker:bg-accent"
            >
              <AgentTypeIcon agentType={row.agent ?? null} size={14} />
            </NativeChatEventIcon>
          ) : (
            <WorkerDockGlyph glyph={row ? workerDockGlyph(row) : 'queued'} />
          )}
        </span>
        {/* A command reads as mono. */}
        <span
          className={cn('min-w-0 flex-1 truncate', row?.kind === 'command' && 'font-mono text-xs')}
        >
          {title}
        </span>
        {row && row.changedAt !== null ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            <Age at={row.changedAt} visible={visible} />
          </span>
        ) : null}
      </button>
      {/* Over the row's end on hover or focus, so at rest the title has the row's whole width. At rest it
          is transparent and takes no presses (a press there opens the row), but stays in the
          accessibility tree and the tab order; focus inside the row shows it. */}
      <div
        data-worker-dock-hover=""
        className={cn(
          // Inset by the focus ring's width, so a focused row's ring closes on all four sides.
          // Empty (no action applies), it draws nothing, so it never covers the age.
          'pointer-events-none absolute inset-y-[2px] right-[2px] flex items-center gap-1 rounded-r-[4px] bg-accent pr-1.5 pl-1.5 [&:not(:has(button,svg))]:hidden',
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
