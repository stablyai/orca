// The open item's place and ↑ ↓ to the previous and next item, in the comment box's tool row. An item with
// no box (deleted, or not read yet) gets a row of the box's shape at the bottom, so the arrows stay put.
import { createContext, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { LoadingSpinner } from '@/components/ui/LoadingSpinner'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useShortcutKeyComboDetails } from '@/lib/keyboard/useShortcutLabel'
import { useKeepFloatingTerminalTriggerClear } from '../../floating-terminal/trigger/floating-terminal-trigger-keep-clear'

export type BotItemStepDirection = 'previous' | 'next'

/** Whether the arrows wait on a read: the comment box holds as it is, so their spinner stays in view. */
export const BotItemSteppingContext = createContext(false)

/** The arrow for `direction`: its attribute marks it for focus moves across a step. */
export function botItemStepArrow(
  pane: HTMLElement | null,
  direction: BotItemStepDirection
): HTMLButtonElement | null {
  return pane?.querySelector<HTMLButtonElement>(`[data-bot-item-step="${direction}"]`) ?? null
}

// On touch, in the narrowest panes, the arrows and the row's gaps shrink so + / arrows / mic / send still fit.
export const BOT_ITEM_TOOL_ROW_TOUCH_FIT = 'pointer-coarse:@max-[260px]/item-pane:gap-0.5'

export function BotItemStepper({
  pane,
  place,
  loading,
  offline,
  canStep,
  onStep
}: {
  /** The item pane: it keeps focus when a focused arrow goes away. */
  pane: React.RefObject<HTMLDivElement | null>
  place: { index: number; total: number }
  /** A Closed page has been reading a while. */
  loading: boolean
  offline: boolean
  canStep: (direction: 1 | -1) => boolean
  onStep: (direction: 1 | -1, from: BotItemStepDirection) => void
}): React.JSX.Element {
  const t = useTranslate()
  const nav = useRef<HTMLDivElement | null>(null)
  const slot = useRef<HTMLSpanElement | null>(null)
  const counter = useRef<HTMLSpanElement | null>(null)
  const counterShows = useShowsWhole(slot, counter)
  const hadFocus = useRef(false)
  const focused = useRef<BotItemStepDirection | null>(null)
  const [tipPlace, setTipPlace] = useState(false)
  // An arrow that goes disabled (an end, a pending read) drops focus; the pane keeps it instead.
  useLayoutEffect(() => {
    const active = document.activeElement
    const dropped =
      active === null ||
      active === document.body ||
      (active instanceof HTMLButtonElement && active.disabled && nav.current?.contains(active))
    if (hadFocus.current && dropped) {
      hadFocus.current = false
      focused.current = null
      pane.current?.focus({ preventScroll: true })
    }
  })
  // Replaced while an arrow had focus (the box gives way to its placeholder row, or back): the same arrow
  // takes it once the replacement is in. Microtask: before any further input, so only this commit moved focus.
  useLayoutEffect(
    () => () => {
      const direction = focused.current
      if (direction) {
        queueMicrotask(() => keepArrowFocus(pane.current, direction))
      }
    },
    [pane]
  )
  const placeLabel = t('bots.items.view.placeOf', '{{index}} of {{total}}', place)
  const arrow = (direction: BotItemStepDirection): React.JSX.Element => {
    const step = direction === 'next' ? 1 : -1
    return (
      <BotItemStepArrow
        direction={direction}
        disabled={offline || !canStep(step)}
        // No room for the counter: a read shows on Next instead, the only way pages are read.
        spinner={loading && !counterShows && direction === 'next'}
        place={tipPlace ? placeLabel : null}
        onOpenTip={() => setTipPlace(!counterShows)}
        onClick={() => onStep(step, direction)}
      />
    )
  }
  return (
    <div
      ref={nav}
      role="group"
      aria-label={
        loading
          ? t('bots.items.view.loadingNext', 'Loading next item')
          : t('bots.items.view.navigation', 'Item {{index}} of {{total}}', place)
      }
      className="-my-1 flex min-w-0 flex-1 items-center gap-0.5 pointer-coarse:@max-[260px]/item-pane:gap-0"
      onFocus={(event) => {
        hadFocus.current = true
        const direction = event.target.getAttribute('data-bot-item-step')
        focused.current = direction === 'next' || direction === 'previous' ? direction : null
      }}
      onBlur={(event) => {
        // Focus moved on to something; a drop to nothing (a disabled arrow) is caught above.
        if (event.relatedTarget !== null) {
          hadFocus.current = false
          focused.current = null
        }
      }}
    >
      {/* The free space left of the arrows, one line tall: a counter that doesn't fit whole wraps out of view. */}
      <span
        ref={slot}
        aria-hidden
        className="flex h-4 min-w-0 flex-1 flex-wrap items-center justify-end overflow-hidden"
      >
        <span className="h-4 w-0" />
        <span
          ref={counter}
          className="relative inline-flex h-4 items-center px-1 text-xs whitespace-nowrap text-muted-foreground tabular-nums"
        >
          {/* The place keeps its width while loading, so whether it fits never depends on the spinner. */}
          <span className={loading ? 'invisible' : undefined}>
            {t('bots.items.view.place', '{{index}} / {{total}}', place)}
          </span>
          {loading ? (
            <span className="absolute inset-0 flex items-center justify-center">
              <LoadingSpinner className="size-3.5" />
            </span>
          ) : null}
        </span>
      </span>
      {arrow('previous')}
      {arrow('next')}
      <span
        aria-hidden
        data-bot-item-divider=""
        className="mx-2 h-4 w-px shrink-0 bg-border @max-[230px]/item-pane:hidden pointer-coarse:@max-[260px]/item-pane:hidden"
      />
    </div>
  )
}

function BotItemStepArrow({
  direction,
  disabled,
  spinner,
  place,
  onOpenTip,
  onClick
}: {
  direction: BotItemStepDirection
  disabled: boolean
  /** A spinner in place of the chevron. */
  spinner: boolean
  place: string | null
  onOpenTip: () => void
  onClick: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const shortcut = useShortcutKeyComboDetails(
    direction === 'next' ? 'botItem.next' : 'botItem.previous'
  )[0]
  const label =
    direction === 'next'
      ? t('bots.items.view.next', 'Next item')
      : t('bots.items.view.previous', 'Previous item')
  const Icon = direction === 'next' ? ChevronDown : ChevronUp
  return (
    <Tooltip onOpenChange={(open) => (open ? onOpenTip() : undefined)}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          data-bot-item-step={direction}
          className="pointer-coarse:@max-[260px]/item-pane:size-6"
          disabled={disabled}
          onClick={onClick}
        >
          {spinner ? <LoadingSpinner className="size-4" /> : <Icon />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        <span className="flex items-center gap-2">
          {place ? `${label} · ${place}` : label}
          {shortcut ? <ShortcutKeyCombo {...shortcut} size="compact" /> : null}
        </span>
      </TooltipContent>
    </Tooltip>
  )
}

/** Whether `item` sits on `slot`'s first line, so it shows whole. */
function useShowsWhole(
  slot: React.RefObject<HTMLElement | null>,
  item: React.RefObject<HTMLElement | null>
): boolean {
  const [shows, setShows] = useState(true)
  useLayoutEffect(() => {
    const box = slot.current
    const node = item.current
    if (!box || !node) {
      return
    }
    const measure = (): void =>
      setShows(node.getBoundingClientRect().top - box.getBoundingClientRect().top < 1)
    measure()
    // The pane's width and the counter's digits both change what fits.
    const observer = new ResizeObserver(measure)
    observer.observe(box)
    observer.observe(node)
    return () => observer.disconnect()
  }, [slot, item])
  return shows
}

function keepArrowFocus(pane: HTMLElement | null, direction: BotItemStepDirection): void {
  const active = document.activeElement
  // Only this pane's own homes (where its item's takeFocus put focus) count; another pane's choice stays.
  const dropped =
    active === null ||
    active === document.body ||
    active === pane ||
    (pane?.contains(active) === true && active.hasAttribute('data-bot-item-focus-home'))
  const arrow = botItemStepArrow(pane, direction)
  if (pane && dropped && arrow && !arrow.disabled) {
    arrow.focus()
  } else if (pane && (active === null || active === document.body)) {
    // No enabled arrow to take it (offline, say): the pane keeps Esc, the chords and typing working.
    pane.focus({ preventScroll: true })
  }
}

/** Where an item has no comment box: the box's footprint with only the arrows, where the box's sit. */
export function BotItemNavRow({
  nav,
  plain = false
}: {
  nav: React.ReactNode
  /** Under an open question's card: the arrows alone, no box (an empty box there reads as a text field). The
   *  insets stand in for the box's border and padding, so the arrows still sit where the box's do. */
  plain?: boolean
}): React.JSX.Element {
  const box = useRef<HTMLDivElement | null>(null)
  // Like the comment box: the floating terminal button moves out of its way.
  useKeepFloatingTerminalTriggerClear(box)
  return (
    <div
      ref={box}
      className={cn(
        'mx-3 mt-auto mb-3 flex shrink-0 flex-col',
        plain ? 'px-[13px] pt-1 pb-[13px]' : 'rounded-[10px] border border-border bg-background p-3'
      )}
    >
      {/* Nothing follows the divider here; it keeps its room so the arrows sit where the box's do. */}
      <div
        className={cn(
          'flex items-center gap-1 [&_[data-bot-item-divider]]:invisible',
          BOT_ITEM_TOOL_ROW_TOUCH_FIT
        )}
      >
        {nav}
        {/* Mic and send's room, so the arrows sit where they do in the box. */}
        <span aria-hidden className="invisible -my-1 size-8 shrink-0 pointer-coarse:size-11" />
        <span aria-hidden className="invisible size-6 shrink-0 pointer-coarse:size-8" />
      </div>
    </div>
  )
}
