import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { RoomAgentActivity, RoomParticipant } from '../../../../shared/rooms'
import { roomActivityFinalMessage, RoomActivityCard, RoomActivitySummary } from './RoomActivityCard'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

const SAFE_MARGIN_RATIO = 0.12
const SAFE_MARGIN_MIN = 12
const SAFE_MARGIN_MAX_X = 48
const SAFE_MARGIN_MAX_Y = 32
const OWNED_PORTAL_SELECTOR = '[data-room-activity-stack-portal]'

export function RoomActivityStack({
  activities,
  participants,
  target
}: {
  activities: RoomAgentActivity[]
  participants: RoomParticipant[]
  target?: RuntimeClientTarget
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const collapseRef = useRef<HTMLButtonElement>(null)
  const participantById = useMemo(
    () => new Map(participants.map((participant) => [participant.id, participant])),
    [participants]
  )
  const finalizing = activities.filter(roomActivityFinalMessage)
  useActivityStackDismiss(open && finalizing.length === 0, rootRef, setOpen, triggerRef)

  if (activities.length === 0) {
    return null
  }
  if (finalizing.length > 0) {
    const live = activities.filter((activity) => !roomActivityFinalMessage(activity))
    return (
      <div className="space-y-2">
        {live.length > 0 ? (
          <RoomActivityStack activities={live} participants={participants} target={target} />
        ) : null}
        {finalizing.map((activity) => (
          <RoomActivityCard
            key={`${activity.participantId}:${activity.startedAt}`}
            activity={activity}
            participant={participantById.get(activity.participantId)}
            target={target}
          />
        ))}
      </div>
    )
  }
  if (activities.length === 1) {
    const activity = activities[0]!
    return (
      <RoomActivityCard
        activity={activity}
        participant={participantById.get(activity.participantId)}
        target={target}
      />
    )
  }

  const front = activities[0]!
  const additionalCount = activities.length - 1
  return (
    <Collapsible
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (nextOpen) {
          requestAnimationFrame(() => collapseRef.current?.focus())
        }
      }}
    >
      <div
        ref={rootRef}
        className="grid"
        data-room-activity-stack
        data-state={open ? 'open' : 'closed'}
      >
        <div
          aria-hidden={open || undefined}
          inert={open}
          className={cn(
            'relative self-end [grid-area:1/1] transition-opacity duration-200 ease motion-reduce:transition-none',
            open && 'pointer-events-none opacity-0'
          )}
        >
          <div className={cn('relative', activities.length > 2 ? 'pt-6' : 'pt-2')}>
            <div
              aria-hidden
              className="room-activity-stack-sheet room-activity-stack-sheet-back pointer-events-none absolute inset-x-3 bottom-2 top-0 rounded-lg border border-border/60 bg-background"
            >
              {activities.length > 2 ? (
                <span className="flex h-3 items-center justify-end pr-3 text-[11px] leading-none tabular-nums text-muted-foreground">
                  {translate('rooms.activity.more', '+{{count}} more', {
                    count: additionalCount
                  })}
                </span>
              ) : null}
            </div>
            {activities.length > 2 ? (
              <div
                aria-hidden
                className="room-activity-stack-sheet room-activity-stack-sheet-middle pointer-events-none absolute inset-x-1.5 bottom-1 top-3 rounded-lg border border-border/65 bg-background"
              />
            ) : null}
            <CollapsibleTrigger asChild>
              <RoomActivitySummary
                ref={triggerRef}
                className="relative bg-background shadow-xs transition-colors duration-200 ease can-hover:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 motion-reduce:transition-none"
                activity={front}
                participant={participantById.get(front.participantId)}
                expanded={open}
                aria-label={translate(
                  'rooms.activity.showStack',
                  'Show {{count}} activity updates',
                  { count: activities.length }
                )}
              />
            </CollapsibleTrigger>
          </div>
        </div>

        <CollapsibleContent className="room-activity-disclosure-content [grid-area:1/1]">
          <div className="space-y-2">
            {activities.map((activity) => (
              <RoomActivityCard
                key={`${activity.participantId}:${activity.startedAt}`}
                activity={activity}
                participant={participantById.get(activity.participantId)}
                target={target}
              />
            ))}
            <div className="flex justify-end pt-0.5">
              <CollapsibleTrigger asChild>
                <Button
                  ref={collapseRef}
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => requestAnimationFrame(() => triggerRef.current?.focus())}
                >
                  <ChevronDown />
                  {translate('rooms.activity.collapseStack', 'Collapse activities')}
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export function isOutsideActivityStackSafeArea(
  point: { x: number; y: number },
  rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>
): boolean {
  const marginX = Math.min(
    SAFE_MARGIN_MAX_X,
    Math.max(SAFE_MARGIN_MIN, rect.width * SAFE_MARGIN_RATIO)
  )
  const marginY = Math.min(
    SAFE_MARGIN_MAX_Y,
    Math.max(SAFE_MARGIN_MIN, rect.height * SAFE_MARGIN_RATIO)
  )
  return (
    point.x < rect.left - marginX ||
    point.x > rect.right + marginX ||
    point.y < rect.top - marginY ||
    point.y > rect.bottom + marginY
  )
}

function useActivityStackDismiss(
  open: boolean,
  rootRef: React.RefObject<HTMLDivElement | null>,
  setOpen: (open: boolean) => void,
  triggerRef: React.RefObject<HTMLButtonElement | null>
): void {
  const pointerStartedOutsideRef = useRef(false)

  useEffect(() => {
    if (!open) {
      return
    }
    let closeFrame: number | null = null
    const outsideSafeArea = (event: MouseEvent | PointerEvent): boolean => {
      const root = rootRef.current
      return Boolean(
        root &&
        !root.contains(event.target as Node) &&
        isOutsideActivityStackSafeArea(
          { x: event.clientX, y: event.clientY },
          root.getBoundingClientRect()
        )
      )
    }
    const onPointerDown = (event: PointerEvent): void => {
      pointerStartedOutsideRef.current =
        !document.querySelector(OWNED_PORTAL_SELECTOR) && outsideSafeArea(event)
    }
    const onClick = (event: MouseEvent): void => {
      if (!pointerStartedOutsideRef.current || !outsideSafeArea(event)) {
        pointerStartedOutsideRef.current = false
        return
      }
      pointerStartedOutsideRef.current = false
      closeFrame = requestAnimationFrame(() => setOpen(false))
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector(OWNED_PORTAL_SELECTOR)
      ) {
        return
      }
      setOpen(false)
      requestAnimationFrame(() => triggerRef.current?.focus())
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKeyDown)
      if (closeFrame !== null) {
        cancelAnimationFrame(closeFrame)
      }
    }
  }, [open, rootRef, setOpen, triggerRef])
}
