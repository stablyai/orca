import { useLayoutEffect, useRef } from 'react'
import { Pause, Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '../../store'
import { translate } from '@/i18n/i18n'
import { NativeChatQueuedMessageCard } from './NativeChatQueuedMessageCard'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

/**
 * Host-held drafts stacked between the transcript and the composer — never in
 * the transcript: a draft only becomes a bubble once the host consumes it into
 * a submission. The live region stays mounted while empty, so the first card is announced.
 */
export function NativeChatQueuedMessageList({
  controller,
  steerHeld = false,
  focusComposer
}: {
  controller: StructuredAgentSessionQueuedMessagesController
  /** The chat reads Stopping: no card steers into the turn a Stop is ending. */
  steerHeld?: boolean
  /** Where focus goes once Steer, Edit or Delete takes the focused card away. */
  focusComposer?: () => void
}): React.JSX.Element {
  const updateSettings = useAppStore((store) => store.updateSettings)
  const queueRef = useRef<HTMLDivElement>(null)
  const { cards, pause } = controller
  const newest = cards.at(-1)
  const listRef = useRef<HTMLUListElement>(null)
  const newestPosition = newest?.position ?? 0
  const newestIsPersons = newest !== undefined && !newest.from
  const shownPosition = useRef(newestPosition)
  // Before paint, so the new card never shows a frame before the scroll.
  useLayoutEffect(() => {
    // From 0 the queue is loading or holds one card: nothing to scroll to.
    const appended = shownPosition.current > 0 && newestPosition > shownPosition.current
    shownPosition.current = newestPosition
    // The list opens on the next card to send; a card the person just queued is shown instead.
    if (appended && newestIsPersons && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [newestPosition, newestIsPersons])
  // Only a host that queues sends has queueing to turn off; a kept card shows without it.
  const turnOffQueueing = controller.queueCapable
    ? () => void updateSettings({ nativeChatQueueFollowUps: false })
    : undefined
  // Only when focus was on the queue (a card, or Resume) — never pull it from wherever the user
  // moved on to.
  const refocusAfter = (action: Promise<unknown>): void => {
    void action.then(() => {
      const active = document.activeElement
      if (!active || active === document.body || queueRef.current?.contains(active)) {
        focusComposer?.()
      }
    })
  }
  return (
    <div aria-live="polite">
      {cards.length > 0 ? (
        <div ref={queueRef} className="mx-auto w-full max-w-(--chat-content-max-width) px-4 py-1">
          {/* One box: the pause row, when shown, is its first row, and each card a row below it. */}
          <div className="divide-y divide-border rounded-md border border-border bg-card text-card-foreground">
            {pause ? (
              <NativeChatQueuePauseRow
                pause={pause}
                resuming={controller.resuming}
                onResume={() => refocusAfter(controller.resume())}
              />
            ) : null}
            <ul
              ref={listRef}
              aria-label={translate(
                'components.native-chat.queuedMessages.listLabel',
                'Queued messages'
              )}
              // Scrolls on its own so a long queue never squeezes the transcript or the composer.
              className="scrollbar-sleek max-h-40 divide-y divide-border overflow-y-auto"
            >
              {cards.map((card) => (
                <NativeChatQueuedMessageCard
                  key={card.messageId}
                  card={card}
                  showsSteerShortcut={controller.queueCapable && card === newest}
                  steerHeld={steerHeld}
                  onSteer={() => refocusAfter(controller.steer(card.messageId))}
                  onDelete={() => refocusAfter(controller.remove(card.messageId))}
                  onEdit={() => refocusAfter(controller.edit(card.messageId))}
                  onTurnOffQueueing={turnOffQueueing}
                />
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Why the queue sends nothing on its own. An unknown reason (a newer host) is a plain pause. */
function queuePauseText(pause: { reason: string }): string {
  switch (pause.reason) {
    case 'stopped':
      return translate(
        'components.native-chat.queuedMessages.queuePausedStopped',
        'Queue paused because you interrupted'
      )
    default:
      return translate('components.native-chat.queuedMessages.queuePaused', 'Queue paused')
  }
}

function NativeChatQueuePauseRow({
  pause,
  resuming,
  onResume
}: {
  pause: { reason: string }
  resuming: boolean
  onResume: () => void
}): React.JSX.Element {
  const text = queuePauseText(pause)
  return (
    <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground">
      <Pause className="size-3.5 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 truncate" title={text}>
        {text}
      </p>
      <Button type="button" variant="ghost" size="xs" disabled={resuming} onClick={onResume}>
        <Play className="size-3" />
        {translate('components.native-chat.queuedMessages.resume', 'Resume')}
      </Button>
    </div>
  )
}
