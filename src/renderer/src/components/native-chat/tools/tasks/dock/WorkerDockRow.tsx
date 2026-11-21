import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { workerDockKindLabel, workerDockStateLabel } from './worker-dock-labels'
import { memo, useRef, useState } from 'react'
import {
  Circle,
  CircleAlert,
  CircleDashed,
  CircleHelp,
  CirclePause,
  Loader2,
  Square,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useNowSnapshot } from '@/lib/window-activity/use-now'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { formatCompactDuration } from '../../../../../../../shared/agent-status/presentation/agent-row-decay-state'
import { cn } from '@/lib/class-names'
import type { WorkerDockEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'
import { subagentModelLabel } from '../../../../../../../shared/native-chat/transcript/subagents/native-chat-subagent-entry-detail'

function Age({ at, visible }: { at: number | null; visible: boolean }) {
  const t = useTranslate()
  const locale = useIntlLocale()
  const label = useNowSnapshot(
    30_000,
    (now) => (at === null ? '—' : formatShortTimeAgo(at, now)),
    visible && at !== null
  )
  return (
    <span
      className="w-11 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
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
  clearable?: boolean
}
export const WorkerDockRow = memo(function WorkerDockRow({
  row,
  narrow,
  compact = false,
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
  const gesture = useRef<{
    row: WorkerDockRowView
    action: 'stop' | 'clear'
    rect: DOMRect | null
    cancelled: boolean
    activated: boolean
  } | null>(null)
  const [focusedAction, setFocusedAction] = useState<'stop' | 'clear' | null>(null)
  const failed = row.state === 'failed' || row.state === 'unexpected'
  const action = focusedAction ?? (failed && row.clearable !== false ? 'clear' : 'stop')
  const unavailable =
    row.ownerActionsAvailable === false ||
    row.retired ||
    row.state === 'saving' ||
    !row.stoppable ||
    pending
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
  return (
    <div
      data-worker-dock-row={row.id}
      className="group/worker relative flex min-w-0 items-start text-foreground"
    >
      <button
        type="button"
        data-worker-dock-open={row.id}
        className={cn(
          'flex min-w-0 flex-1 items-start gap-2 px-4 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          narrow ? 'pr-0' : 'items-center'
        )}
        aria-label={`${row.name} · ${row.title} · ${state}${row.reason ? ` · ${row.reason}` : ''}`}
        title={`${row.name} · ${row.title}${row.model ? ` · ${row.model}` : ''}${row.startedAt ? t('components.native-chat.workerDock.startedAt', ' · Started {{time}} · {{elapsed}} elapsed', { time: new Date(row.startedAt).toLocaleString(locale), elapsed }) : ''}${t('components.native-chat.workerDock.contactUnavailable', ' · Last confirmed contact unavailable')}`}
        onClick={(event) => onOpen(row, event.currentTarget)}
      >
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
            <span className="max-w-30 truncate text-sm font-medium">{row.name}</span>
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
            {(failed || row.state === 'unavailable' || row.state === 'stopping') && row.reason ? (
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
                {row.reason}
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
      <div
        className={cn(
          'flex shrink-0 justify-center pt-1.5',
          narrow ? 'w-11' : 'w-10',
          action === 'stop' &&
            'opacity-0 group-hover/worker:opacity-100 group-focus-within/worker:opacity-100 [@media(pointer:coarse)]:opacity-100'
        )}
      >
        {row.stoppable || failed || row.retired || row.state === 'saving' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost-inset"
                size="icon-xs"
                data-worker-dock-action={row.id}
                className={cn(narrow ? (action === 'clear' ? 'h-6 w-11' : 'size-11') : 'size-6.5')}
                aria-label={
                  action === 'clear'
                    ? t('components.native-chat.workerDock.clearName', 'Clear {{name}}', {
                        name: row.name
                      })
                    : unavailable
                      ? t(
                          'components.native-chat.workerDock.stopUnavailable',
                          'Stop {{name}} · {{title}} unavailable · {{reason}}',
                          {
                            name: row.name,
                            title: row.title,
                            reason:
                              row.state === 'saving'
                                ? workerDockStateLabel(t, 'saving')
                                : row.retired
                                  ? t(
                                      'components.native-chat.workerDock.resultReady',
                                      'result ready'
                                    )
                                  : failed
                                    ? workerDockStateLabel(t, row.state)
                                    : pending
                                      ? workerDockStateLabel(t, 'stopping')
                                      : workerDockStateLabel(t, 'unavailable')
                          }
                        )
                      : t(
                          'components.native-chat.workerDock.stopName',
                          'Stop {{name}} · {{title}}',
                          { name: row.name, title: row.title }
                        )
                }
                aria-disabled={
                  row.ownerActionsAvailable === false || (action === 'stop' ? unavailable : pending)
                }
                onPointerDown={(event) => {
                  if (event.button === 0) {
                    window.addEventListener(
                      'pointerup',
                      () =>
                        setTimeout(() => {
                          gesture.current = null
                        }, 0),
                      { once: true }
                    )
                    gesture.current = {
                      row,
                      action,
                      rect: event.currentTarget.getBoundingClientRect(),
                      cancelled: false,
                      activated: false
                    }
                  }
                }}
                onPointerLeave={() => {
                  if (gesture.current?.rect) {
                    gesture.current.cancelled = true
                  }
                }}
                onPointerMove={(event) => {
                  const current = gesture.current
                  const rect = current?.rect
                  if (
                    current &&
                    rect &&
                    event.buttons &&
                    (event.clientX < rect.left ||
                      event.clientX > rect.right ||
                      event.clientY < rect.top ||
                      event.clientY > rect.bottom)
                  ) {
                    current.cancelled = true
                  }
                }}
                onPointerCancel={() => {
                  if (gesture.current) {
                    gesture.current.cancelled = true
                  }
                }}
                onKeyDown={(event) => {
                  if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
                    gesture.current = {
                      row,
                      action,
                      rect: null,
                      cancelled: false,
                      activated: false
                    }
                  }
                }}
                onKeyUp={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    setTimeout(() => {
                      gesture.current = null
                    }, 0)
                  }
                }}
                onBlur={() => {
                  gesture.current = null
                  setFocusedAction(null)
                }}
                onFocus={() => setFocusedAction(action)}
                onClick={() => {
                  const captured = gesture.current
                  if (captured?.cancelled || captured?.activated) {
                    return
                  }
                  const intendedRow = captured?.row ?? row
                  const intendedAction = captured?.action ?? action
                  if (
                    intendedRow.ownerActionsAvailable !== false &&
                    (intendedAction === 'clear' ? !pending : !unavailable)
                  ) {
                    if (captured) {
                      captured.activated = true
                    }
                    onAction(intendedRow, intendedAction)
                  }
                }}
              >
                {action === 'clear' ? (
                  <X className="size-4" />
                ) : (
                  <Square className="size-4 p-1" fill="currentColor" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {row.ownerActionsAvailable === false
                ? t(
                    'components.native-chat.workerDock.remoteOwner',
                    'Stop or clear this from the computer it runs on'
                  )
                : pending
                  ? t('components.native-chat.workerDock.stopping', 'Stopping…')
                  : action === 'clear'
                    ? t('components.native-chat.workerDock.clear', 'Clear')
                    : t('components.native-chat.workerDock.stop', 'Stop')}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
})
