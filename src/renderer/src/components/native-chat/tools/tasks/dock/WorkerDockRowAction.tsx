import { useTranslate } from '@/i18n/use-translate'
import { workerDockSpokenTitle, workerDockStateLabel } from './worker-dock-labels'
import { useContext, useRef, useState } from 'react'
import { Square, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
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
  pending,
  onAction
}: {
  row: WorkerDockRowView
  pending: boolean
  onAction: (row: WorkerDockRowView, action: 'stop' | 'clear') => void
}) {
  const t = useTranslate()
  // One press per input, each cleared only by its own release: a mouse press, a touch press and a
  // key press can overlap, and none may end, or activate as, another.
  const pointerPresses = useRef(new Map<number, Press & { rect: DOMRect }>())
  // The pointer press whose release produced the click that follows it, so a click activates as
  // the press it came from, not the latest one.
  const releasedPointer = useRef<Press | null>(null)
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
    // Above the row's stretched open button, so a press here never opens the worker. The row shows
    // it on hover or focus.
    <div className="relative z-10 flex shrink-0 items-center">
      {canClear || canStop ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              // The roster clips its edges at narrow widths, so the focus ring is drawn inside.
              variant="ghost-on-accent-inset"
              size="icon-xs"
              data-worker-dock-action={row.id}
              className="size-5 [@media(pointer:coarse)]:size-7"
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
                          title: workerDockSpokenTitle(row.kind, row.title),
                          reason: workerDockStateLabel(t, 'stopping')
                        }
                      )
                    : t('components.native-chat.workerDock.stopName', 'Stop {{name}} · {{title}}', {
                        name: row.name,
                        title: workerDockSpokenTitle(row.kind, row.title)
                      })
              }
              aria-disabled={action === 'stop' ? unavailable : pending}
              onPointerDown={(event) => {
                if (event.button !== 0) {
                  return
                }
                const pointerId = event.pointerId
                const press = {
                  ...startPress(),
                  rect: event.currentTarget.getBoundingClientRect()
                }
                pointerPresses.current.set(pointerId, press)
                const end = (released: PointerEvent) => {
                  if (released.pointerId !== pointerId) {
                    return
                  }
                  window.removeEventListener('pointerup', end, true)
                  window.removeEventListener('pointercancel', end, true)
                  if (pointerPresses.current.get(pointerId) === press) {
                    pointerPresses.current.delete(pointerId)
                  }
                  if (released.type !== 'pointerup') {
                    press.cancelled = true
                    return
                  }
                  // This release's click, if any, follows it in the same task and reads the press.
                  releasedPointer.current = press
                  setTimeout(() => {
                    if (releasedPointer.current === press) {
                      releasedPointer.current = null
                    }
                  }, 0)
                }
                window.addEventListener('pointerup', end, true)
                window.addEventListener('pointercancel', end, true)
              }}
              onPointerLeave={(event) => {
                // Only a press still held: a touch leaves after its own release.
                const current = pointerPresses.current.get(event.pointerId)
                if (current) {
                  current.cancelled = true
                }
              }}
              onPointerMove={(event) => {
                const current = pointerPresses.current.get(event.pointerId)
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
              onPointerCancel={(event) => {
                const current = pointerPresses.current.get(event.pointerId)
                if (current) {
                  current.cancelled = true
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
                for (const press of [...pointerPresses.current.values(), keyPress.current]) {
                  if (press) {
                    press.cancelled = true
                  }
                }
                setFocusedAction(null)
              }}
              onFocus={() => setFocusedAction(action)}
              onClick={(event) => {
                // A keyboard activation clicks with detail 0, a pointer one with its click count
                // right after that pointer's release.
                const captured = event.detail === 0 ? keyPress.current : releasedPointer.current
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
                <X className="size-3.5" />
              ) : (
                <Square className="size-3.5 p-[3px]" fill="currentColor" />
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
