import { memo, useRef } from 'react'
import {
  Bot,
  CircleAlert,
  CircleHelp,
  CirclePause,
  Loader2,
  Square,
  SquareTerminal,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useNowSnapshot } from '@/hooks/use-now'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { getIntlLocale } from '@/i18n/i18n'
import { cn } from '@/lib/class-names'
import type { WorkerDockEntry } from '../../../../../../../shared/orchestration/dock/worker-dock'

export const workerDockStateLabel: Record<WorkerDockEntry['state'], string> = {
  starting: 'Starting',
  running: 'Running',
  waiting: 'Waiting on coordinator',
  coordinator: 'Waiting on coordinator',
  idle: 'Idle',
  saving: 'Saving result…',
  failed: 'Failed',
  unexpected: 'Stopped unexpectedly',
  stopping: 'Stopping…',
  unavailable: 'Status unavailable',
  'needs-you': 'Waiting on you'
}
function Age({ at, visible }: { at: number | null; visible: boolean }) {
  const label = useNowSnapshot(
    30_000,
    (now) => (at === null ? '—' : formatShortTimeAgo(at, now)),
    visible && at !== null
  )
  return (
    <span
      className="shrink-0 text-xs tabular-nums text-muted-foreground"
      title={at === null ? 'Status time unavailable' : new Date(at).toLocaleString(getIntlLocale())}
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
  mixed,
  modelColumn,
  visible,
  pending,
  onOpen,
  onAction
}: {
  row: WorkerDockRowView
  narrow: boolean
  mixed: boolean
  modelColumn: boolean
  visible: boolean
  pending: boolean
  onOpen: (row: WorkerDockRowView, opener: HTMLElement) => void
  onAction: (row: WorkerDockRowView, action: 'stop' | 'clear') => void
}) {
  const gesture = useRef<{
    row: WorkerDockRowView
    action: 'stop' | 'clear'
    rect: DOMRect | null
    cancelled: boolean
    activated: boolean
  } | null>(null)
  const failed = row.state === 'failed' || row.state === 'unexpected'
  const action = failed && row.clearable !== false ? 'clear' : 'stop'
  const unavailable =
    row.ownerActionsAvailable === false ||
    row.retired ||
    row.state === 'saving' ||
    !row.stoppable ||
    pending
  const state = row.retired ? 'Done · open result' : workerDockStateLabel[row.state]
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
          : row.kind === 'command'
            ? SquareTerminal
            : Bot
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
        title={`${row.name} · ${row.title}${row.model ? ` · ${row.model}` : ''}${row.startedAt ? ` · Started ${new Date(row.startedAt).toLocaleString(getIntlLocale())}` : ''}`}
        onClick={(event) => onOpen(row, event.currentTarget)}
      >
        <Icon
          aria-hidden="true"
          className={cn(
            'mt-0.5 size-4 shrink-0',
            (row.state === 'running' || row.state === 'starting' || row.state === 'stopping') &&
              !row.retired &&
              'animate-spin motion-reduce:animate-none'
          )}
        />
        <span className="min-w-0 flex-1">
          <span className={cn('flex min-w-0 gap-x-2', narrow ? 'flex-col' : 'items-baseline')}>
            <span className="max-w-30 truncate text-sm font-medium">{row.name}</span>
            <span className={cn('min-w-0 text-sm', narrow ? 'line-clamp-1' : 'truncate')}>
              {row.title}
            </span>
          </span>
          {mixed || row.state !== 'running' || row.retired ? (
            <span data-worker-dock-state="" className="block text-xs text-muted-foreground">
              {mixed
                ? `${row.kind === 'worker' ? 'Worker' : row.kind === 'command' ? 'Command' : 'Agent'} · `
                : ''}
              {row.state === 'running' && !row.retired ? '' : state}
            </span>
          ) : null}
          {(failed || row.state === 'unavailable' || row.state === 'stopping') && row.reason ? (
            <span
              data-worker-dock-reason=""
              className={cn(
                'block text-xs text-muted-foreground',
                narrow ? 'line-clamp-2' : 'line-clamp-1'
              )}
            >
              {row.reason}
            </span>
          ) : null}
        </span>
        {modelColumn && !narrow ? (
          <span className="max-w-25 truncate text-xs text-muted-foreground">
            {row.model ?? '—'}
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
                variant="ghost"
                size="icon-xs"
                data-worker-dock-action={row.id}
                className={cn(
                  '[&_svg]:pointer-events-none',
                  narrow ? (action === 'clear' ? 'h-6 w-11' : 'size-11') : 'size-6.5'
                )}
                aria-label={
                  action === 'clear'
                    ? `Clear ${row.name}`
                    : unavailable
                      ? `Stop ${row.name} · ${row.title} unavailable · ${row.state === 'saving' ? 'saving result' : row.retired ? 'result ready' : pending ? 'stopping' : 'status unavailable'}`
                      : `Stop ${row.name} · ${row.title}`
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
                }}
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
                ? 'Stop or clear this from the computer it runs on'
                : pending
                  ? 'Stopping…'
                  : action === 'clear'
                    ? 'Clear'
                    : 'Stop'}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )
})
