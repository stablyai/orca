import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { RoomAgentActivity, RoomParticipant } from '../../../../shared/rooms'
import { RoomActivityCard } from './RoomActivityCard'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { useQueuedMessageContainerPresence } from '../native-chat/QueuedMessageList'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

const SAFE_MARGIN_RATIO = 0.12
const SAFE_MARGIN_MIN = 12
const SAFE_MARGIN_MAX_X = 48
const SAFE_MARGIN_MAX_Y = 32
const OWNED_PORTAL_SELECTOR = '[data-room-activity-stack-portal]'

export function RoomActivityStack({
  activities,
  lastSteeredParticipantId,
  participants,
  target
}: {
  activities: RoomAgentActivity[]
  lastSteeredParticipantId?: string | null
  participants: RoomParticipant[]
  target?: RuntimeClientTarget
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [cycleFrontParticipantId, setCycleFrontParticipantId] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const collapseRef = useRef<HTMLButtonElement>(null)
  const reducedMotion = usePrefersReducedMotion()
  const retainedActivities = useRef(activities)
  const presence = useQueuedMessageContainerPresence(activities.length > 0)
  if (activities.length > 0) {
    retainedActivities.current = activities
  }
  const visibleActivities = activities.length > 0 ? activities : retainedActivities.current
  const participantById = useMemo(
    () => new Map(participants.map((participant) => [participant.id, participant])),
    [participants]
  )
  const desiredFront =
    visibleActivities.find((activity) => activity.participantId === lastSteeredParticipantId) ??
    visibleActivities[0]
  const desiredFrontParticipantIdRef = useRef<string | null>(null)
  desiredFrontParticipantIdRef.current = desiredFront?.participantId ?? null
  const finishClose = useCallback(() => {
    setClosing(false)
    setCycleFrontParticipantId(null)
    requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
  }, [])
  const setStackOpen = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (nextOpen) {
        setCycleFrontParticipantId(desiredFrontParticipantIdRef.current)
        setClosing(false)
        requestAnimationFrame(() => collapseRef.current?.focus({ preventScroll: true }))
      } else if (reducedMotion) {
        requestAnimationFrame(finishClose)
      } else {
        setClosing(true)
      }
    },
    [finishClose, reducedMotion]
  )
  useActivityStackDismiss(open, rootRef, setStackOpen, triggerRef)

  if (!presence.mounted || visibleActivities.length === 0) {
    return null
  }
  if (visibleActivities.length === 1) {
    const activity = visibleActivities[0]!
    return roomActivityStackPresence(
      presence.visible,
      <RoomActivityCard
        activity={activity}
        participant={participantById.get(activity.participantId)}
        target={target}
      />
    )
  }

  const front =
    visibleActivities.find(
      (activity) =>
        activity.participantId ===
        (open || closing ? cycleFrontParticipantId : desiredFront?.participantId)
    ) ?? visibleActivities[0]!
  const otherActivities = visibleActivities.filter(
    (activity) => activity.participantId !== front.participantId
  )
  const additionalCount = visibleActivities.length - 1
  return roomActivityStackPresence(
    presence.visible,
    <Collapsible open={open}>
      <div
        ref={rootRef}
        data-room-activity-stack
        data-state={open ? 'open' : 'closed'}
        className={cn(
          visibleActivities.length > 4 &&
            'queued-message-scroll-fade scrollbar-sleek max-h-[280px] overflow-y-auto'
        )}
      >
        <CollapsibleContent
          data-room-activity-others
          inert={!open || undefined}
          className="chat-activity-disclosure-content"
          onAnimationEnd={(event) => {
            if (event.target === event.currentTarget && !open && closing) {
              finishClose()
            }
          }}
        >
          <div className="space-y-2">
            {otherActivities.map((activity) => (
              <div
                key={`${activity.participantId}:${activity.startedAt}`}
                data-room-activity-row={activity.participantId}
              >
                <RoomActivityCard
                  activity={activity}
                  participant={participantById.get(activity.participantId)}
                  target={target}
                />
              </div>
            ))}
          </div>
        </CollapsibleContent>
        <div
          data-room-activity-row={front.participantId}
          inert={closing || undefined}
          className={cn(
            'relative transition-[padding] duration-200 ease motion-reduce:transition-none',
            open ? 'pt-2' : visibleActivities.length > 2 ? 'pt-6' : 'pt-2'
          )}
        >
          <div
            aria-hidden
            className="room-activity-stack-sheet room-activity-stack-sheet-back pointer-events-none absolute inset-x-3 bottom-2 top-0 rounded-lg border border-border/60 bg-background"
          >
            {visibleActivities.length > 2 ? (
              <span className="flex h-3 items-center justify-end pr-3 text-[11px] leading-none tabular-nums text-muted-foreground">
                {translate('rooms.activity.more', '+{{count}} more', {
                  count: additionalCount
                })}
              </span>
            ) : null}
          </div>
          {visibleActivities.length > 2 ? (
            <div
              aria-hidden
              className="room-activity-stack-sheet room-activity-stack-sheet-middle pointer-events-none absolute inset-x-1.5 bottom-1 top-3 rounded-lg border border-border/65 bg-background"
            />
          ) : null}
          <div className="relative">
            <RoomActivityCard
              key={`${front.participantId}:${front.startedAt}`}
              activity={front}
              participant={participantById.get(front.participantId)}
              target={target}
              stack={{
                open,
                onOpen: () => setStackOpen(true),
                triggerRef,
                ariaLabel: translate(
                  'rooms.activity.showStack',
                  'Show {{count}} activity updates',
                  {
                    count: visibleActivities.length
                  }
                )
              }}
            />
          </div>
        </div>
        <div
          data-room-activity-collapse
          aria-hidden={!open || undefined}
          inert={!open || undefined}
          className={cn(
            'grid transition-[grid-template-rows,opacity] duration-200 ease motion-reduce:transition-none',
            open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className="min-h-0 overflow-hidden">
            <div className="flex justify-end pt-0.5">
              <Button
                ref={collapseRef}
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => setStackOpen(false)}
              >
                <ChevronDown />
                {translate('rooms.activity.collapseStack', 'Collapse activities')}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </Collapsible>
  )
}

function roomActivityStackPresence(visible: boolean, children: React.ReactNode): React.JSX.Element {
  return (
    <div
      className={cn(
        'grid shrink-0 transition-[grid-template-rows,opacity] duration-200 ease motion-reduce:transition-none',
        visible ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          className={cn(
            'px-4 pt-2 transition-transform duration-200 ease motion-reduce:transition-none',
            visible ? 'translate-y-0' : 'translate-y-4'
          )}
        >
          <div className="mx-auto w-full max-w-4xl">{children}</div>
        </div>
      </div>
    </div>
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
