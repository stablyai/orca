import { useTranslate } from '@/i18n/use-translate'
import { workerDockStateLabel } from './worker-dock-labels'
import { useContext, useRef, useState } from 'react'
import { Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import type { WorkerDockRowView } from './WorkerDockRow'
import { WorkerDockFeedLossesContext, workerDockCanStop } from './worker-dock-stop-check'

type Press = {
  row: WorkerDockRowView
  action: 'stop' | 'clear'
  cancelled: boolean
  activated: boolean
  /** The feed this press started on, and its loss count then. */
  readLosses: () => number
  losses: number
}

/** A press the feed dropped during, or that started on another feed, is cancelled even after the
 *  feed recovers: the row it was aimed at may not be the worker it is now. */
function workerDockPressStillLive(press: Press, readLosses: () => number): boolean {
  return (
    !press.cancelled &&
    !press.activated &&
    press.readLosses === readLosses &&
    press.losses === readLosses()
  )
}

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
  // One press per input, each cleared only by its own release: a mouse press and a key press can
  // overlap, and neither may end, or activate as, the other.
  const pointerPress = useRef<(Press & { pointerId: number; rect: DOMRect }) | null>(null)
  const keyPress = useRef<(Press & { key: string }) | null>(null)
  const readLosses = useContext(WorkerDockFeedLossesContext)
  const [focusedAction, setFocusedAction] = useState<'stop' | 'clear' | null>(null)
  const failed = row.state === 'failed' || row.state === 'unexpected'
  const owner = row.ownerActionsAvailable !== false && !row.retired
  // Only an action that can run gets a button: a remote worker, a cleared row or a failure with
  // nothing to acknowledge shows none rather than a live-looking control that does nothing.
  const canClear = owner && failed && Boolean(row.settlement)
  // The same rule a Stop is checked against when it is sent.
  const canStop = workerDockCanStop(row)
  const action = focusedAction ?? (canClear ? 'clear' : 'stop')
  const unavailable = !canStop || pending
  const startPress = (): Press => ({
    row,
    action,
    cancelled: false,
    activated: false,
    readLosses,
    losses: readLosses()
  })
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
              // The roster clips its edges at narrow widths, so the focus ring is drawn inside.
              variant="ghost-on-accent-inset"
              size="icon-xs"
              data-worker-dock-action={row.id}
              className={cn(narrow ? (action === 'clear' ? 'h-6 w-11' : 'size-11') : 'size-6.5')}
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
                if (event.button !== 0) {
                  return
                }
                const press = {
                  ...startPress(),
                  pointerId: event.pointerId,
                  rect: event.currentTarget.getBoundingClientRect()
                }
                pointerPress.current = press
                const end = (released: PointerEvent) => {
                  if (released.pointerId !== press.pointerId) {
                    return
                  }
                  window.removeEventListener('pointerup', end, true)
                  window.removeEventListener('pointercancel', end, true)
                  // After this release's click, which reads the press.
                  setTimeout(() => {
                    if (pointerPress.current === press) {
                      pointerPress.current = null
                    }
                  }, 0)
                }
                window.addEventListener('pointerup', end, true)
                window.addEventListener('pointercancel', end, true)
              }}
              onPointerLeave={() => {
                if (pointerPress.current) {
                  pointerPress.current.cancelled = true
                }
              }}
              onPointerMove={(event) => {
                const current = pointerPress.current
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
                if (pointerPress.current) {
                  pointerPress.current.cancelled = true
                }
              }}
              onKeyDown={(event) => {
                if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
                  keyPress.current = { ...startPress(), key: event.key }
                }
              }}
              onKeyUp={(event) => {
                const press = keyPress.current
                // Only the key that started the press ends it.
                if (press?.key === event.key) {
                  setTimeout(() => {
                    if (keyPress.current === press) {
                      keyPress.current = null
                    }
                  }, 0)
                }
              }}
              onBlur={() => {
                // Without focus no held press may activate; each is cleared by its own release.
                for (const press of [pointerPress.current, keyPress.current]) {
                  if (press) {
                    press.cancelled = true
                  }
                }
                setFocusedAction(null)
              }}
              onFocus={() => setFocusedAction(action)}
              onClick={(event) => {
                // A keyboard activation clicks with detail 0, a pointer one with its click count.
                const captured = event.detail === 0 ? keyPress.current : pointerPress.current
                if (captured && !workerDockPressStillLive(captured, readLosses)) {
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
