import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { workerDockKindLabel, workerDockStateLabel } from './worker-dock-labels'
import { memo } from 'react'
import { Circle, CircleAlert, CircleDashed, CircleHelp, CirclePause, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { WorkerDockRowAction } from './WorkerDockRowAction'
import { useNowSnapshot } from '@/lib/window-activity/use-now'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { formatCompactDuration } from '../../../../../../../shared/agent-status/presentation/agent-row-decay-state'
import { cn } from '@/lib/class-names'
import type { WorkerDockEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { subagentModelLabel } from '../../../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-entry-detail'

function Age({ at, visible, fit }: { at: number | null; visible: boolean; fit?: boolean }) {
  const t = useTranslate()
  const locale = useIntlLocale()
  const label = useNowSnapshot(
    30_000,
    (now) => (at === null ? '—' : formatShortTimeAgo(at, now)),
    visible && at !== null
  )
  return (
    <span
      className={cn(
        'shrink-0 text-right text-xs tabular-nums text-muted-foreground',
        !fit && 'w-11'
      )}
      title={
        at === null
          ? t('components.native-chat.workerDock.timeUnavailable', 'Status time unavailable')
          : new Date(at).toLocaleString(locale)
      }
    >
      {label}
    </span>
  )
}
export type WorkerDockRowView = WorkerDockEntry & {
  retired?: boolean
  providerId?: string
  /** The open question a needs-you worker asked, shown in full on the lead row. */
  question?: string
}
export const WorkerDockRow = memo(function WorkerDockRow({
  row,
  narrow,
  compact = false,
  lead = false,
  mixed,
  modelColumn,
  visible,
  pending,
  onOpen,
  onAction
}: {
  row: WorkerDockRowView
  narrow: boolean
  compact?: boolean
  /** The newest needs-attention row: its full question and its action, not one truncated line. */
  lead?: boolean
  mixed: boolean
  modelColumn: boolean
  visible: boolean
  pending: boolean
  onOpen: (row: WorkerDockRowView, opener: HTMLElement) => void
  onAction: (row: WorkerDockRowView, action: 'stop' | 'clear') => void
}) {
  const t = useTranslate()
  const locale = useIntlLocale()
  const elapsed = useNowSnapshot(
    30_000,
    (now) => (row.startedAt === null ? '' : formatCompactDuration(now - row.startedAt)),
    visible && row.startedAt !== null && row.state === 'running'
  )
  const failed = row.state === 'failed' || row.state === 'unexpected'
  const state = row.retired
    ? t('components.native-chat.workerDock.doneResult', 'Done · open result')
    : workerDockStateLabel(t, row.state)
  const stateTone = failed
    ? 'text-destructive'
    : row.state === 'needs-you'
      ? 'text-chat-warning'
      : 'text-muted-foreground'
  const Icon = failed
    ? CircleAlert
    : row.state === 'needs-you'
      ? CircleHelp
      : row.state === 'idle'
        ? CirclePause
        : row.state === 'running' ||
            row.state === 'starting' ||
            row.state === 'stopping' ||
            row.state === 'saving'
          ? Loader2
          : row.state === 'unavailable'
            ? CircleDashed
            : Circle
  // A remote chat's worker is shown, not driven, here: its row says where to act instead.
  const remote = row.kind === 'worker' && row.ownerActionsAvailable === false
  const tooltip = `${row.name} · ${row.title}${row.model ? ` · ${row.model}` : ''}${row.startedAt ? t('components.native-chat.workerDock.startedAt', ' · Started {{time}} · {{elapsed}} elapsed', { time: new Date(row.startedAt).toLocaleString(locale), elapsed }) : ''}${t('components.native-chat.workerDock.contactUnavailable', ' · Last confirmed contact unavailable')}${remote ? ` · ${t('components.native-chat.workerDock.remoteOwner', 'Stop or clear this from the computer it runs on')}` : ''}`
  const reason =
    (failed || row.state === 'unavailable' || row.state === 'stopping') && row.reason
      ? row.reason
      : null
  const icon = (
    <Icon
      aria-hidden="true"
      className={cn(
        'mt-0.5 size-4 shrink-0',
        stateTone,
        (row.state === 'running' || row.state === 'starting' || row.state === 'stopping') &&
          !row.retired &&
          'animate-spin motion-reduce:animate-none'
      )}
    />
  )
  return (
    <div
      data-worker-dock-row={row.id}
      data-worker-dock-lead={lead ? '' : undefined}
      className="group/worker relative flex min-w-0 items-start text-foreground"
    >
      {lead ? (
        <div
          className={cn(
            'flex min-w-0 flex-1 items-start gap-2 py-2 pl-4',
            narrow ? 'pr-0' : 'pr-4'
          )}
          title={row.question ? `${row.question}\n${tooltip}` : tooltip}
        >
          {icon}
          <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
            <div className="flex w-full min-w-0 items-baseline gap-2">
              <span className="max-w-30 shrink-0 truncate text-sm font-medium">{row.name}</span>
              <span
                data-worker-dock-state=""
                className={cn('min-w-0 flex-1 truncate text-xs', stateTone)}
              >
                {mixed ? `${workerDockKindLabel(t, row.kind)} · ` : ''}
                {state}
              </span>
              <Age at={row.changedAt} visible={visible} fit />
            </div>
            <p
              data-worker-dock-question=""
              className={cn('text-sm break-words', compact ? 'line-clamp-2' : 'line-clamp-3')}
            >
              {row.question ?? row.title}
            </p>
            {reason ? (
              <p data-worker-dock-reason="" className="line-clamp-2 text-xs text-muted-foreground">
                {reason}
              </p>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="xs"
              data-worker-dock-open={row.id}
              aria-label={t('components.native-chat.workerDock.showName', 'Show {{name}}', {
                name: row.name
              })}
              onClick={(event) => onOpen(row, event.currentTarget)}
            >
              {t('components.native-chat.workerDock.show', 'Show')}
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-worker-dock-open={row.id}
          className={cn(
            'flex min-w-0 flex-1 items-start gap-2 px-4 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
            narrow ? 'pr-0' : 'items-center'
          )}
          aria-label={`${row.name} · ${row.title} · ${state}${row.reason ? ` · ${row.reason}` : ''}${remote ? ` · ${t('components.native-chat.workerDock.remoteOwner', 'Stop or clear this from the computer it runs on')}` : ''}`}
          title={tooltip}
          onClick={(event) => onOpen(row, event.currentTarget)}
        >
          {icon}
          <span
            className={cn(
              'min-w-0 flex-1',
              !narrow && 'flex items-center gap-2',
              compact && narrow && 'flex flex-wrap items-baseline gap-x-2'
            )}
          >
            <span
              className={cn(
                'flex min-w-0 gap-x-2',
                narrow ? (compact ? 'contents' : 'flex-col') : 'flex-1 items-baseline'
              )}
            >
              <span className="max-w-30 shrink-0 truncate text-sm font-medium">{row.name}</span>
              <span
                className={cn(
                  'min-w-0 text-sm',
                  narrow ? (compact ? 'hidden' : 'line-clamp-1') : 'truncate'
                )}
              >
                {row.title}
              </span>
            </span>
            <span
              className={cn(
                !narrow && 'flex min-w-0 items-baseline gap-2',
                compact && narrow && 'contents'
              )}
            >
              {mixed || row.state !== 'running' || row.retired ? (
                <span
                  data-worker-dock-state=""
                  className={cn(
                    'text-xs',
                    stateTone,
                    narrow ? (compact ? 'shrink-0' : 'block') : 'max-w-40 truncate'
                  )}
                >
                  {mixed ? `${workerDockKindLabel(t, row.kind)} · ` : ''}
                  {row.state === 'running' && !row.retired ? '' : state}
                </span>
              ) : null}
              {reason ? (
                <span
                  data-worker-dock-reason=""
                  className={cn(
                    'text-xs text-muted-foreground',
                    narrow
                      ? compact
                        ? 'w-full line-clamp-2'
                        : 'block line-clamp-2'
                      : 'min-w-0 max-w-48 truncate'
                  )}
                >
                  {reason}
                </span>
              ) : null}
            </span>
          </span>
          {modelColumn && !narrow ? (
            <span className="max-w-25 truncate text-xs text-muted-foreground">
              {row.model ? subagentModelLabel(row.model) : '—'}
            </span>
          ) : null}
          <Age at={row.changedAt} visible={visible} />
        </button>
      )}
      <WorkerDockRowAction row={row} narrow={narrow} pending={pending} onAction={onAction} />
    </div>
  )
})
