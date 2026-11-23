import { useTranslate } from '@/i18n/use-translate'
import { workerDockStateLabel } from './worker-dock-labels'
import { useRef, useState } from 'react'
import { Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import type { WorkerDockRowView } from './WorkerDockRow'

/** A dock row's Stop or Clear, which keeps the pressed intent through a structural update. */
export function WorkerDockRowAction({
  row,
  narrow,
  pending,
  onAction
}: {
  row: WorkerDockRowView
  narrow: boolean
  pending: boolean
  onAction: (row: WorkerDockRowView, action: 'stop' | 'clear') => void
}) {
  const t = useTranslate()
  const gesture = useRef<{
    row: WorkerDockRowView
    action: 'stop' | 'clear'
    rect: DOMRect | null
    cancelled: boolean
    activated: boolean
  } | null>(null)
  const [focusedAction, setFocusedAction] = useState<'stop' | 'clear' | null>(null)
  const failed = row.state === 'failed' || row.state === 'unexpected'
  const owner = row.ownerActionsAvailable !== false && !row.retired
  // Only an action that can run gets a button: a remote worker, a cleared row or a failure with
  // nothing to acknowledge shows none rather than a live-looking control that does nothing.
  const canClear = owner && failed && Boolean(row.settlement)
  // An exited worker with an open dispatch has nothing to clear; Stop settles it.
  const exitedOpen = row.state === 'unexpected' && !row.settlement
  const canStop = owner && (!failed || exitedOpen) && row.stoppable && row.state !== 'saving'
  const action = focusedAction ?? (canClear ? 'clear' : 'stop')
  const unavailable = !canStop || pending
  return (
    <div
      className={cn(
        'flex shrink-0 justify-center pt-1.5',
        narrow ? 'w-11' : 'w-10',
        action === 'stop' &&
          !pending &&
          'opacity-0 group-hover/worker:opacity-100 group-focus-within/worker:opacity-100 [@media(pointer:coarse)]:opacity-100'
      )}
    >
      {canClear || canStop ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost-on-accent"
              size="icon-xs"
              data-worker-dock-action={row.id}
              className={cn(
                'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                narrow ? (action === 'clear' ? 'h-6 w-11' : 'size-11') : 'size-6.5'
              )}
              aria-label={
                action === 'clear'
                  ? t('components.native-chat.workerDock.clearName', 'Clear {{name}}', {
                      name: row.name
                    })
                  : pending
                    ? t(
                        'components.native-chat.workerDock.stopUnavailable',
                        'Stop {{name}} · {{title}} unavailable · {{reason}}',
                        {
                          name: row.name,
                          title: row.title,
                          reason: workerDockStateLabel(t, 'stopping')
                        }
                      )
                    : t('components.native-chat.workerDock.stopName', 'Stop {{name}} · {{title}}', {
                        name: row.name,
                        title: row.title
                      })
              }
              aria-disabled={action === 'stop' ? unavailable : pending}
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
                if (intendedAction === 'clear' ? canClear && !pending : !unavailable) {
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
            {pending
              ? t('components.native-chat.workerDock.stopping', 'Stopping…')
              : action === 'clear'
                ? t('components.native-chat.workerDock.clear', 'Clear')
                : t('components.native-chat.workerDock.stop', 'Stop')}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}
