import { useTranslate } from '@/i18n/use-translate'
import { useEffect, useLayoutEffect, type KeyboardEvent, type RefObject } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { cn } from '@/lib/class-names'
import { ChevronDown } from 'lucide-react'
import { WorkerDockGlyph } from './WorkerDockGlyph'
import type { WorkerDockGlyph as Glyph } from './worker-dock-card-order'

/** The chip's height (26px) plus 8px: the room the transcript keeps clear at its end. The chip sits
 *  on the dock's top edge, which the next box (message box, question, queue) already pads by 8px. */
const PILL_ROOM = '34px'

// Where Jump to latest rests: on the chip's row, or just above the open panel.
const JUMP_LIFT = '--native-chat-worker-jump-lift'
// While the chip shows, Jump to latest shares its row as a right-aligned round arrow.
const WORKER_ROW = 'data-native-chat-worker-row'

export const WORKER_DOCK_FLOAT_CLASS =
  'pointer-events-none absolute inset-x-0 bottom-full z-20 h-0 [[data-native-chat-dock-fit~=dock]_&]:static [[data-native-chat-dock-fit~=dock]_&]:flex [[data-native-chat-dock-fit~=dock]_&]:h-auto [[data-native-chat-dock-fit~=dock]_&]:flex-col [[data-native-chat-dock-fit~=dock]_&]:pt-2'
// Raised over the transcript, opaque even when the chat's message-box surface is translucent.
export const WORKER_DOCK_SURFACE_CLASS =
  'pointer-events-auto border border-border bg-chat-canvas bg-[linear-gradient(var(--color-chat-composer-surface),var(--color-chat-composer-surface))] text-foreground [[data-native-chat-dock-fit~=dock]_&]:static'

/** The worker chip ("3 workers"); while the panel is open, the same button is the panel's header. */
export function WorkerDockPill({
  pill,
  glyph,
  label,
  latest,
  total,
  expanded,
  listId,
  onToggle,
  onKeyDown
}: {
  pill: RefObject<HTMLButtonElement | null>
  glyph: Glyph
  /** The chip's text: how many workers, or what is known when none are listed. */
  label: string
  /** The most relevant worker's title, for assistive technology. */
  latest: string
  total: number
  expanded: boolean
  listId: string
  onToggle: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const t = useTranslate()
  // Only while the chip shows does the transcript reserve its room and Jump to latest join its row.
  useLayoutEffect(() => {
    const pane = pill.current?.closest<HTMLElement>('[data-native-chat-root]')
    if (!pane) {
      return
    }
    pane.style.setProperty('--native-chat-worker-pill-room', PILL_ROOM)
    pane.style.setProperty(JUMP_LIFT, '0px')
    pane.setAttribute(WORKER_ROW, '')
    return () => {
      pane.style.removeProperty('--native-chat-worker-pill-room')
      pane.style.removeProperty(JUMP_LIFT)
      pane.removeAttribute(WORKER_ROW)
    }
  }, [pill])
  return (
    <button
      ref={pill}
      type="button"
      data-worker-dock-pill=""
      aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined}
      aria-label={
        total > 0
          ? t(
              'components.native-chat.workerDock.pillLabel',
              '{{count}} workers, latest: {{title}}',
              {
                count: total,
                title: latest,
                defaultValue_one: '{{count}} worker, latest: {{title}}'
              }
            )
          : label
      }
      className={cn(
        'flex shrink-0 items-center gap-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        expanded
          ? 'h-[30px] w-full rounded-md bg-muted px-2.5 hover:bg-accent'
          : cn(
              WORKER_DOCK_SURFACE_CLASS,
              'h-[26px] max-w-full rounded-full px-2.5 shadow-sm hover:bg-accent'
            )
      )}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      {expanded ? (
        <>
          <span className="font-medium">
            {t('components.native-chat.workerDock.workersRegion', 'Workers')}
          </span>
          {total > 0 ? <span className="tabular-nums text-muted-foreground">{total}</span> : null}
          <ChevronDown aria-hidden="true" className="ml-auto size-3.5 text-muted-foreground" />
        </>
      ) : (
        <>
          <WorkerDockGlyph glyph={glyph} />
          <span data-worker-dock-pill-title="" className="min-w-0 truncate">
            {label}
          </span>
        </>
      )}
    </button>
  )
}

// A dialog, menu or toast a row opened is portalled out of the card but still belongs to it.
const KEEPS_CARD_OPEN =
  '[role="dialog"],[role="alertdialog"],[data-radix-popper-content-wrapper],[data-sonner-toaster]'

/** While the card is open, a press anywhere outside the pill and the card folds it, as Escape does. */
export function useWorkerDockOutsidePress(
  root: RefObject<HTMLElement | null>,
  open: boolean,
  onOutside: () => void
): void {
  const fold = useLatestHandler(onOutside)
  useEffect(() => {
    if (!open) {
      return
    }
    const press = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element) || root.current?.contains(target)) {
        return
      }
      // Folding under a row's dialog would unmount the row it returns focus to. This pane's Jump to
      // latest shares the card's slot: folding on its press would move it before the click lands.
      // Another pane's Jump is just outside.
      const pane = root.current?.closest('[data-native-chat-root]')
      const ownJump = Boolean(
        pane?.contains(target) && target.closest('[data-native-chat-jump-latest]')
      )
      if (!ownJump && !target.closest(KEEPS_CARD_OPEN)) {
        fold()
      }
    }
    document.addEventListener('pointerdown', press, true)
    return () => document.removeEventListener('pointerdown', press, true)
  }, [root, open, fold])
}

/** While the panel is open, Jump to latest rests 8px above it instead of hiding behind it. */
export function useWorkerDockJumpLift(card: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const element = card.current
    const pane = element?.closest<HTMLElement>('[data-native-chat-root]')
    if (!open || !element || !pane || typeof ResizeObserver === 'undefined') {
      return
    }
    const lift = () => pane.style.setProperty(JUMP_LIFT, `${element.offsetHeight + 8}px`)
    const observer = new ResizeObserver(lift)
    observer.observe(element)
    lift()
    return () => {
      observer.disconnect()
      // Back onto the chip's row, unless the chip already left and cleared it.
      if (pane.hasAttribute(WORKER_ROW)) {
        pane.style.setProperty(JUMP_LIFT, '0px')
      }
    }
  }, [card, open])
}
