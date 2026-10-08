// The rail itself: a column of ticks down the right edge of the transcript, one
// per user message. Each tick previews its own message and the agent's reply
// while hovered or focused, and jumps to the message on click.

import { memo, useLayoutEffect, useRef, useState } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  NATIVE_CHAT_RAIL_ROOMY_TICKS,
  type NativeChatRailItem
} from './native-chat-message-rail-items'
import type { NativeChatMessageRailState } from './use-native-chat-message-rail'

const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
/** Nominal line height for line-mode wheel deltas, which arrive as ~3 per notch. */
const WHEEL_LINE_PX = 16

function railItemLabel(item: NativeChatRailItem): string {
  if (item.text.length > 0) {
    return item.text
  }
  return item.hasImages
    ? translate('components.native-chat.railImageMessage', 'Image attachment')
    : translate('components.native-chat.railEmptyMessage', 'Message')
}

/** Where the card sits, and the reply it showed, latched on close for its exit animation. */
type NativeChatRailPreviewTarget = { id: string; top: number; reply: string }

/** From a tick's centre up to the card's top edge, so the card's first line meets
 *  the tick: the card's `p-4` plus half a `text-xs leading-snug` line. */
const PREVIEW_FIRST_LINE_PX = 24

/** How far a navigation key moves through the messages; null for any other key. */
function railKeyStep(key: string, index: number, count: number): number | null {
  if (key === 'ArrowDown') {
    return index + 1
  }
  if (key === 'ArrowUp') {
    return index - 1
  }
  if (key === 'Home') {
    return 0
  }
  return key === 'End' ? count - 1 : null
}

export const NativeChatMessageRail = memo(function NativeChatMessageRail({
  rail,
  scrollRef,
  onSelect,
  onReaderScroll,
  pendingId = null
}: {
  rail: NativeChatMessageRailState
  scrollRef: React.RefObject<HTMLDivElement | null>
  onSelect: (item: NativeChatRailItem) => void
  /** The reader scrolled the transcript through the rail. */
  onReaderScroll?: (deltaY: number) => void
  /** A tick whose older history is still paging in. */
  pendingId?: string | null
}): React.JSX.Element | null {
  const [target, setTarget] = useState<NativeChatRailPreviewTarget | null>(null)
  const railRef = useRef<HTMLDivElement>(null)
  /** A message an arrow key asked to focus, whose tick may not be drawn until the next render. */
  const focusRequest = useRef<string | null>(null)
  const { ticks, items, focusId } = rail

  useLayoutEffect(() => {
    if (focusRequest.current !== focusId) {
      return
    }
    const index = ticks.findIndex((item) => item.id === focusId)
    if (index !== -1) {
      focusRequest.current = null
      railRef.current?.querySelectorAll('button')[index]?.focus()
    }
  }, [focusId, ticks])

  if (!rail.visible) {
    return null
  }

  const previewed = target === null ? null : (ticks.find((item) => item.id === target.id) ?? null)
  const previewedId = rail.previewId !== null && previewed ? previewed.id : null
  const reply = previewedId === null ? (target?.reply ?? '') : rail.previewReply
  // One tab stop for the whole rail; arrow keys walk it from there.
  const tabId =
    [focusId, rail.activeId].find((id) => ticks.some((item) => item.id === id)) ?? ticks[0]?.id

  const show = (item: NativeChatRailItem, element: HTMLElement): void => {
    setTarget({ id: item.id, top: element.offsetTop + element.offsetHeight / 2, reply: '' })
    rail.onPreview(item.id)
  }
  const close = (): void => {
    setTarget((current) => current && { ...current, reply: rail.previewReply })
    rail.onPreview(null)
  }

  return (
    // One card for the whole rail, moved to the tick it previews: a card per tick
    // would animate out and in again on every step between neighbours. The ticks
    // open it; the card's own hover, blur and Escape handling closes it.
    <HoverCard
      open={previewedId !== null}
      onOpenChange={(next) => !next && close()}
      openDelay={0}
      closeDelay={100}
    >
      <HoverCardTrigger asChild>
        <div
          ref={railRef}
          role="toolbar"
          data-native-chat-rail
          aria-label={translate('components.native-chat.railLabel', 'Your messages')}
          aria-orientation="vertical"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) {
              rail.onFocusItem(null)
            }
          }}
          onKeyDown={(event) => {
            // Through every message, not only the drawn ticks: a long thread samples them.
            const next = railKeyStep(
              event.key,
              items.findIndex((item) => item.id === tabId),
              items.length
            )
            if (next === null) {
              return
            }
            event.preventDefault()
            const item = items[next]
            if (item) {
              focusRequest.current = item.id
              rail.onFocusItem(item.id)
            }
          }}
          // The rail overlays the transcript without being inside it, so a wheel
          // here would otherwise land on nothing and freeze the scroll. Deltas
          // arrive in lines or pages on some platforms, not only in pixels.
          onWheel={(event) => {
            const element = scrollRef.current
            if (!element) {
              return
            }
            const scale =
              event.deltaMode === WHEEL_DELTA_LINE
                ? WHEEL_LINE_PX
                : event.deltaMode === WHEEL_DELTA_PAGE
                  ? element.clientHeight
                  : 1
            if (event.ctrlKey) {
              return
            }
            onReaderScroll?.(event.deltaY * scale)
            element.scrollTop += event.deltaY * scale
          }}
          className="absolute top-1/2 right-2.5 z-10 flex w-6 -translate-y-1/2 flex-col"
        >
          {ticks.map((item) => {
            // The pointer or keyboard owns the fill while a preview is open; otherwise
            // the fill reports the scroll position.
            const lit = item.id === (previewedId ?? rail.activeId)
            return (
              <button
                key={item.id}
                type="button"
                tabIndex={item.id === tabId ? 0 : -1}
                aria-label={railItemLabel(item)}
                aria-current={item.id === rail.activeId ? 'true' : undefined}
                aria-busy={item.id === pendingId ? true : undefined}
                onPointerEnter={(event) => {
                  if (event.pointerType !== 'touch') {
                    show(item, event.currentTarget)
                  }
                }}
                onFocus={(event) => {
                  rail.onFocusItem(item.id)
                  // A click focuses the tick too, and must not reopen the preview it dismissed.
                  if (event.currentTarget.matches(':focus-visible')) {
                    show(item, event.currentTarget)
                  }
                }}
                onClick={() => onSelect(item)}
                // Padding, not a gap, so the pointer never falls between two ticks.
                className={cn(
                  'flex w-full shrink-0 cursor-pointer items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  ticks.length > NATIVE_CHAT_RAIL_ROOMY_TICKS ? 'py-0.5' : 'py-1'
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    'h-[3px] rounded-full transition-[width,background-color] duration-150',
                    lit ? 'w-5 bg-foreground' : 'w-3 bg-foreground/50',
                    item.id === pendingId && 'animate-pulse'
                  )}
                />
              </button>
            )
          })}
        </div>
      </HoverCardTrigger>
      <HoverCardContent
        side="left"
        align="start"
        alignOffset={(target?.top ?? 0) - PREVIEW_FIRST_LINE_PX}
        sideOffset={8}
        className="w-72"
      >
        {previewed ? (
          <div className="flex flex-col gap-1">
            <p className="line-clamp-2 text-xs leading-snug text-foreground">
              {railItemLabel(previewed)}
            </p>
            {reply.length > 0 ? (
              <p className="line-clamp-3 text-xs leading-snug text-muted-foreground">{reply}</p>
            ) : null}
          </div>
        ) : null}
      </HoverCardContent>
    </HoverCard>
  )
})
