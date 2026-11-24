import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  selectNativeChatRailTicks,
  type NativeChatRailItem
} from './native-chat-message-rail-items'
import { nativeChatRailItemLabel } from './native-chat-rail-item-label'
import { NativeChatRailMessagePanel } from './NativeChatRailMessagePanel'
import type { NativeChatMessageRailState } from './use-native-chat-message-rail'
import { useNativeChatRailListOpen } from './use-native-chat-rail-list-open'
import { useNativeChatTranscriptInteractive } from '../../conversation/projection/NativeChatContextClearFade'

const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
/** Nominal line height for line-mode wheel deltas, which arrive as ~3 per notch. */
const WHEEL_LINE_PX = 16

/** Where the card sits, and the reply it showed, latched on close for its exit animation. */
type NativeChatRailPreviewTarget = { id: string; top: number; reply: string }

/** Align the first preview line with its tick: p-4 plus half a text-xs leading-snug line. */
const PREVIEW_FIRST_LINE_PX = 24

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
  railRef,
  scrollRef,
  onSelect,
  onReaderScroll,
  pendingId = null,
  listEnabled = true
}: {
  rail: NativeChatMessageRailState
  /** The rail's node; scrolling lights it through a data attribute (see useNativeChatRailWake). */
  railRef: React.RefObject<HTMLDivElement | null>
  scrollRef: React.RefObject<HTMLDivElement | null>
  onSelect: (item: NativeChatRailItem) => void
  /** The reader scrolled the transcript through the rail. */
  onReaderScroll?: (deltaY: number) => void
  /** A tick whose older history is still paging in. */
  pendingId?: string | null
  /** The conversation's transcript is shown: the list may open. */
  listEnabled?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  useUiLanguageRevision()
  const [target, setTarget] = useState<NativeChatRailPreviewTarget | null>(null)
  /** A message an arrow key asked to focus, whose tick may not be drawn until the next render. */
  const focusRequest = useRef<string | null>(null)
  const { items, focusId, listMode } = rail
  const interactive = useNativeChatTranscriptInteractive()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const panelId = useId()
  const list = useNativeChatRailListOpen({
    enabled: rail.visible && listMode && listEnabled && interactive,
    railRef,
    panelRef
  })
  const { openerId } = list
  const ticks = useMemo(
    () =>
      selectNativeChatRailTicks({
        items,
        keepIds: [rail.activeId, openerId, focusId, pendingId, rail.previewId]
      }),
    [items, rail.activeId, openerId, focusId, pendingId, rail.previewId]
  )
  const positions = useMemo(() => new Map(items.map((item, index) => [item.id, index])), [items])
  // Picks resolve against committed loaded rows, so a stale row cannot start a jump.
  const loadedRef = useRef(rail.loadedItems)
  useLayoutEffect(() => {
    loadedRef.current = rail.loadedItems
  }, [rail.loadedItems])

  const { dropOpener } = list
  useEffect(() => {
    if (openerId !== null && !positions.has(openerId)) {
      dropOpener()
    }
  }, [dropOpener, openerId, positions])

  useLayoutEffect(() => {
    if (focusRequest.current !== focusId) {
      return
    }
    const index = ticks.findIndex((item) => item.id === focusId)
    if (index !== -1) {
      focusRequest.current = null
      railRef.current?.querySelectorAll('button')[index]?.focus()
    }
  }, [focusId, railRef, ticks])

  if (!rail.visible) {
    return null
  }

  const previewed = target === null ? null : (ticks.find((item) => item.id === target.id) ?? null)
  // Long chats list on hover instead of previewing one message.
  const previewedId = !listMode && rail.previewId !== null && previewed ? previewed.id : null
  const reply = previewedId === null ? (target?.reply ?? '') : rail.previewReply
  // One tab stop for the whole rail; arrow keys walk it from there.
  const restingTabId =
    [focusId, rail.activeId].find((id) => ticks.some((item) => item.id === id)) ?? ticks[0]?.id
  // While focus is in the list, Shift+Tab returns to the tick that opened it.
  const tabId =
    list.open && list.mode === 'focus' && ticks.some((item) => item.id === openerId)
      ? (openerId ?? restingTabId)
      : restingTabId

  const focusTick = (id: string | null): void => {
    const tick = Array.from(
      railRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []
    ).find((button) => button.dataset.nativeChatRailTick === id)
    if (tick && !tick.closest('[inert]') && tick.getClientRects().length > 0) {
      tick.focus()
    }
  }
  const pickListed = (id: string): void => {
    const restoreTo = list.mode === 'focus' ? openerId : null
    list.close('pick')
    if (restoreTo !== null) {
      focusTick(restoreTo)
    }
    const item = loadedRef.current.find((candidate) => candidate.id === id)
    if (item && item.slotIndex !== null) {
      onSelect(item)
    }
  }

  const show = (item: NativeChatRailItem, element: HTMLElement): void => {
    if (listMode) {
      return
    }
    setTarget({ id: item.id, top: element.offsetTop + element.offsetHeight / 2, reply: '' })
    rail.onPreview(item.id)
  }
  const close = (): void => {
    setTarget((current) => current && { ...current, reply: rail.previewReply })
    rail.onPreview(null)
  }

  return (
    <>
      {/* Reuse one preview card so moving between ticks does not replay exit/entry animations. */}
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
            aria-label={t('components.native-chat.railLabel', 'Your messages')}
            aria-orientation="vertical"
            data-list-open={list.open || undefined}
            onPointerEnter={list.pointerEnter}
            onPointerLeave={list.pointerLeave}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget)) {
                rail.onFocusItem(null)
              }
            }}
            onKeyDown={(event) => {
              if (listMode && event.altKey && event.key === 'ArrowDown') {
                event.preventDefault()
                list.openFromKeyboard(tabId ?? null)
                return
              }
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
            // Forward wheel deltas to the overlaid transcript, converting platform line/page units to pixels.
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
            // Dimmed at rest; hover, keyboard focus or scrolling light it, and it fades back once idle.
            className={cn(
              'absolute top-1/2 right-2.5 z-10 flex w-6 -translate-y-1/2 flex-col',
              'opacity-40 transition-opacity delay-700 duration-500 ease-out motion-reduce:transition-none',
              'hover:opacity-100 hover:delay-0 hover:duration-150',
              // The preview card is portaled, so the pointer on it leaves the rail's :hover.
              'data-[state=open]:opacity-100 data-[state=open]:delay-0 data-[state=open]:duration-150',
              'has-focus-visible:opacity-100 has-focus-visible:delay-0 has-focus-visible:duration-150',
              'data-awake:opacity-100 data-awake:delay-0 data-awake:duration-150',
              'data-list-open:opacity-100 data-list-open:delay-0 data-list-open:duration-150'
            )}
          >
            {ticks.map((item) => {
              // Preview ownership overrides scroll-position highlighting.
              const lit = item.id === (previewedId ?? rail.activeId)
              const tabStop = item.id === tabId
              const opensList = listMode && tabStop
              return (
                <button
                  key={item.id}
                  type="button"
                  data-native-chat-rail-tick={item.id}
                  tabIndex={tabStop ? 0 : -1}
                  aria-label={t(
                    'components.native-chat.railTickLabel',
                    'Message {{index}} of {{count}}: {{text}}',
                    {
                      index: (positions.get(item.id) ?? 0) + 1,
                      count: items.length,
                      text: nativeChatRailItemLabel(item, t)
                    }
                  )}
                  aria-expanded={opensList ? list.open : undefined}
                  aria-controls={opensList && list.open ? panelId : undefined}
                  aria-keyshortcuts={opensList ? 'Alt+ArrowDown' : undefined}
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
                  className="flex w-full shrink-0 cursor-pointer items-center justify-center rounded-sm py-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'h-[3px] rounded-full transition-[width,background-color] duration-150 motion-reduce:transition-none',
                      lit ? 'w-5 bg-foreground' : 'w-3 bg-foreground/50',
                      item.id === pendingId &&
                        'animate-pulse motion-reduce:animate-none motion-reduce:opacity-60'
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
                {nativeChatRailItemLabel(previewed, t)}
              </p>
              {reply.length > 0 ? (
                <p className="line-clamp-3 text-xs leading-snug text-muted-foreground">{reply}</p>
              ) : null}
            </div>
          ) : null}
        </HoverCardContent>
      </HoverCard>
      {list.open && listMode ? (
        <NativeChatRailMessagePanel
          panelRef={panelRef}
          panelId={panelId}
          items={rail.loadedItems}
          positions={positions}
          activeId={rail.activeId}
          mode={list.mode}
          focusRequest={list.focusRequest}
          onPick={pickListed}
          onEscape={() => {
            const restoreTo = openerId
            list.close('escape')
            focusTick(restoreTo)
          }}
          onPromote={() => list.promote(restingTabId ?? null)}
          onFocusLeave={() => list.close('blur')}
          onPointerEnter={list.pointerEnter}
          onPointerLeave={list.pointerLeave}
        />
      ) : null}
    </>
  )
})
