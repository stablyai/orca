import { memo, useCallback, useId, useLayoutEffect, useRef, useState } from 'react'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { VirtualizedList } from '@/components/virtualized-list'
import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import {
  NATIVE_CHAT_RAIL_ROOMY_TICKS,
  type NativeChatRailItem
} from './native-chat-message-rail-items'
import type { NativeChatMessageRailState } from './use-native-chat-message-rail'

const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
/** Nominal line height for line-mode wheel deltas, which arrive as ~3 per notch. */
const WHEEL_LINE_PX = 16

function railItemLabel(item: NativeChatRailItem, t: Translate = translate): string {
  if (item.text.length > 0) {
    return item.text
  }
  return item.hasImages
    ? t('components.native-chat.railImageMessage', 'Image attachment')
    : t('components.native-chat.railEmptyMessage', 'Message')
}

/** Where the card sits, and the reply it showed, latched on close for its exit animation. */
type NativeChatRailPreviewTarget = { id: string; top: number; reply: string }

/** Align the first preview line with its tick: p-4 plus half a text-xs leading-snug line. */
const PREVIEW_FIRST_LINE_PX = 24

/** Leave bounds to the caller so arrow navigation stops at either end instead of wrapping. */
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

/** Share navigation state between the sampled ticks and the windowed message directory. */
export const NativeChatMessageRail = memo(function NativeChatMessageRail({
  rail,
  railRef,
  scrollRef,
  onSelect,
  onReaderScroll,
  pendingId = null
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
}): React.JSX.Element | null {
  const t = useTranslate()
  useUiLanguageRevision()
  const [expanded, setExpanded] = useState(false)
  const [railElement, setRailElement] = useState<HTMLDivElement | null>(null)
  const attachRail = useCallback(
    (element: HTMLDivElement | null) => {
      railRef.current = element
      setRailElement(element)
    },
    [railRef]
  )
  const listId = useId()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const restoreToggleFocus = useRef(false)
  const [target, setTarget] = useState<NativeChatRailPreviewTarget | null>(null)
  /** A message an arrow key asked to focus, whose tick may not be drawn until the next render. */
  const focusRequest = useRef<string | null>(null)
  const { ticks, items, focusId } = rail
  const drawnItems = expanded ? items : ticks

  useLayoutEffect(() => {
    if (restoreToggleFocus.current && !expanded) {
      restoreToggleFocus.current = false
      toggleRef.current?.focus()
    }
    if (focusRequest.current !== focusId) {
      return
    }
    const index = drawnItems.findIndex((item) => item.id === focusId)
    if (index !== -1) {
      const button = Array.from(railElement?.querySelectorAll('button') ?? []).find(
        (element) => element.dataset.messageId === focusId
      )
      if (!button) {
        return
      }
      focusRequest.current = null
      button?.focus({ preventScroll: expanded })
      if (expanded) {
        button?.scrollIntoView?.({ block: 'nearest' })
      }
    }
  }, [drawnItems, expanded, focusId, railElement])

  if (!rail.visible) {
    return null
  }

  const previewed = target === null ? null : (ticks.find((item) => item.id === target.id) ?? null)
  const previewedId = !expanded && rail.previewId !== null && previewed ? previewed.id : null
  const reply = previewedId === null ? (target?.reply ?? '') : rail.previewReply
  // One tab stop for the whole rail; arrow keys walk it from there.
  const tabId =
    [focusId, rail.activeId].find((id) => drawnItems.some((item) => item.id === id)) ??
    drawnItems[0]?.id

  const show = (item: NativeChatRailItem, element: HTMLElement): void => {
    setTarget({ id: item.id, top: element.offsetTop + element.offsetHeight / 2, reply: '' })
    rail.onPreview(item.id)
  }
  const close = (): void => {
    setTarget((current) => current && { ...current, reply: rail.previewReply })
    rail.onPreview(null)
  }
  /** Defer focus transfer until the new mode's message or toggle button has mounted. */
  const toggleExpanded = (): void => {
    close()
    restoreToggleFocus.current = expanded
    focusRequest.current = expanded ? null : (rail.activeId ?? items[0]?.id ?? null)
    rail.onFocusItem(focusRequest.current)
    setExpanded(!expanded)
  }
  const toggleLabel = expanded
    ? t('components.native-chat.railCollapse', 'Collapse message list')
    : t('components.native-chat.railExpand', 'Expand message list')

  /** Keep selection and pending-history feedback consistent across both rail modes. */
  const renderItem = (item: NativeChatRailItem): React.JSX.Element => {
    // Preview ownership overrides scroll-position highlighting.
    const lit = item.id === (previewedId ?? rail.activeId)
    return (
      <button
        key={item.id}
        ref={(button) => {
          // Windowed rows may mount after the rail's own focus effect has run.
          if (expanded && button && focusRequest.current === item.id) {
            focusRequest.current = null
            button.focus({ preventScroll: true })
            button.scrollIntoView?.({ block: 'nearest' })
          }
        }}
        type="button"
        tabIndex={item.id === tabId ? 0 : -1}
        aria-label={railItemLabel(item, t)}
        data-message-id={item.id}
        aria-current={item.id === rail.activeId ? 'true' : undefined}
        aria-busy={item.id === pendingId ? true : undefined}
        onPointerEnter={(event) => {
          if (!expanded && event.pointerType !== 'touch') {
            show(item, event.currentTarget)
          }
        }}
        onFocus={(event) => {
          rail.onFocusItem(item.id)
          // A click focuses the tick too, and must not reopen the preview it dismissed.
          if (!expanded && event.currentTarget.matches(':focus-visible')) {
            show(item, event.currentTarget)
          }
        }}
        onClick={() => onSelect(item)}
        // Padding, not a gap, so the pointer never falls between two ticks.
        className={cn(
          'flex w-full shrink-0 cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          expanded
            ? 'px-3 py-2 text-left hover:bg-accent focus-visible:ring-inset'
            : [
                'items-center justify-center',
                ticks.length > NATIVE_CHAT_RAIL_ROOMY_TICKS ? 'py-0.5' : 'py-1'
              ],
          expanded && item.id === rail.activeId && 'bg-accent'
        )}
        data-current={item.id === rail.activeId ? 'true' : undefined}
      >
        {expanded ? (
          <span className="line-clamp-2 min-w-0 flex-1 break-words text-sm leading-snug">
            {railItemLabel(item, t)}
          </span>
        ) : (
          <span
            aria-hidden
            className={cn(
              'h-[3px] rounded-full transition-[width,background-color] duration-150 motion-reduce:transition-none',
              lit ? 'w-5 bg-foreground' : 'w-3 bg-foreground/50',
              item.id === pendingId &&
                'animate-pulse motion-reduce:animate-none motion-reduce:opacity-60'
            )}
          />
        )}
        {expanded && item.id === pendingId ? (
          <LoadingSpinner className="ml-2 size-3.5 shrink-0" />
        ) : null}
      </button>
    )
  }

  const controls = (
    <div
      className={cn(
        'flex shrink-0 items-center',
        expanded && 'justify-between border-b border-border px-3 py-2'
      )}
    >
      {expanded ? (
        <span className="text-xs font-medium">
          {t('components.native-chat.railLabel', 'Chat history')}
        </span>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            ref={toggleRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={toggleLabel}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={toggleExpanded}
          >
            {expanded ? (
              <PanelRightClose className="size-4" />
            ) : (
              <PanelRightOpen className="size-4" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {toggleLabel}
        </TooltipContent>
      </Tooltip>
    </div>
  )

  return (
    <div
      className={cn(
        'absolute top-1/2 right-2.5 z-10 flex -translate-y-1/2 flex-col',
        expanded &&
          'max-h-[70%] w-72 max-w-[calc(100%-1.25rem)] rounded-md border border-border bg-card text-card-foreground'
      )}
      onKeyDown={(event) => {
        if (expanded && event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          toggleExpanded()
        }
      }}
    >
      {expanded ? controls : null}
      {/* Reuse one preview card so moving between ticks does not replay exit/entry animations. */}
      <HoverCard
        open={previewedId !== null}
        onOpenChange={(next) => !next && close()}
        openDelay={0}
        closeDelay={100}
      >
        <HoverCardTrigger asChild>
          <div
            ref={attachRail}
            id={listId}
            role="toolbar"
            data-native-chat-rail
            aria-label={t('components.native-chat.railLabel', 'Chat history')}
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
            // Forward wheel deltas to the overlaid transcript, converting platform line/page units to pixels.
            onWheel={(event) => {
              if (expanded) {
                return
              }
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
              'flex min-h-0 flex-col',
              expanded ? 'scrollbar-sleek overflow-y-auto p-1' : 'w-6',
              !expanded && [
                'opacity-40 transition-opacity delay-700 duration-500 ease-out motion-reduce:transition-none',
                'hover:opacity-100 hover:delay-0 hover:duration-150',
                // The preview card is portaled, so the pointer on it leaves the rail's :hover.
                'data-[state=open]:opacity-100 data-[state=open]:delay-0 data-[state=open]:duration-150',
                'has-focus-visible:opacity-100 has-focus-visible:delay-0 has-focus-visible:duration-150',
                'data-awake:opacity-100 data-awake:delay-0 data-awake:duration-150'
              ]
            )}
          >
            {expanded ? (
              <VirtualizedList
                rows={items}
                getRowKey={(item) => item.id}
                renderRow={renderItem}
                scrollElement={railElement}
                estimateRowHeightPx={56}
                activeRowKey={tabId}
              />
            ) : (
              ticks.map(renderItem)
            )}
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
                {railItemLabel(previewed, t)}
              </p>
              {reply.length > 0 ? (
                <p className="line-clamp-3 text-xs leading-snug text-muted-foreground">{reply}</p>
              ) : null}
            </div>
          ) : null}
        </HoverCardContent>
      </HoverCard>
      {!expanded ? controls : null}
    </div>
  )
})
