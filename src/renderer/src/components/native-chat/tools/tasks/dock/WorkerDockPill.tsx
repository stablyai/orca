import { useTranslate } from '@/i18n/use-translate'
import { useEffect, useLayoutEffect, type KeyboardEvent, type RefObject } from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { cn } from '@/lib/class-names'
import { WorkerDockGlyph } from './WorkerDockGlyph'
import type { WorkerDockGlyph as Glyph } from './worker-dock-card-order'

/** The pill's height (28px) plus 8px: the room the transcript keeps clear at its end, and where Jump
 *  to latest rests so it stacks 8px above the pill. The pill sits on the dock's top edge, which the
 *  next box (message box, question, queue) already pads by 8px. */
const PILL_ROOM = '36px'

// Where Jump to latest rests: over the pill, or over the open card, never under either.
const JUMP_LIFT = '--native-chat-worker-jump-lift'

export const WORKER_DOCK_FLOAT_CLASS =
  'pointer-events-none absolute inset-x-0 bottom-full z-20 h-0 [[data-native-chat-dock-fit~=dock]_&]:static [[data-native-chat-dock-fit~=dock]_&]:flex [[data-native-chat-dock-fit~=dock]_&]:h-auto [[data-native-chat-dock-fit~=dock]_&]:flex-col [[data-native-chat-dock-fit~=dock]_&]:items-center [[data-native-chat-dock-fit~=dock]_&]:gap-2 [[data-native-chat-dock-fit~=dock]_&]:pt-2'
// Raised over the transcript, opaque even when the chat's message-box surface is translucent.
export const WORKER_DOCK_SURFACE_CLASS =
  'pointer-events-auto border border-border bg-chat-canvas bg-[linear-gradient(var(--color-chat-composer-surface),var(--color-chat-composer-surface))] text-foreground [[data-native-chat-dock-fit~=dock]_&]:static'

/** The collapsed worker card: the most relevant worker's mark and title, and how many more. */
export function WorkerDockPill({
  pill,
  glyph,
  title,
  total,
  expanded,
  listId,
  onToggle,
  onKeyDown
}: {
  pill: RefObject<HTMLButtonElement | null>
  glyph: Glyph
  title: string
  total: number
  expanded: boolean
  listId: string
  onToggle: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const t = useTranslate()
  // Only while the pill shows does the transcript reserve its room and Jump to latest lift over it.
  useLayoutEffect(() => {
    const pane = pill.current?.closest<HTMLElement>('[data-native-chat-root]')
    if (!pane) {
      return
    }
    pane.style.setProperty('--native-chat-worker-pill-room', PILL_ROOM)
    pane.style.setProperty(JUMP_LIFT, PILL_ROOM)
    return () => {
      pane.style.removeProperty('--native-chat-worker-pill-room')
      pane.style.removeProperty(JUMP_LIFT)
    }
  }, [pill])
  const more = total - 1
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
                title,
                defaultValue_one: '{{count}} worker, latest: {{title}}'
              }
            )
          : title
      }
      className={cn(
        WORKER_DOCK_SURFACE_CLASS,
        'absolute inset-x-0 bottom-0 mx-auto flex h-7 w-fit max-w-[min(320px,calc(100%-40px))] items-center gap-1.5 rounded-[14px] pr-2.5 pl-2.5 text-xs shadow-sm hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      onClick={onToggle}
      onKeyDown={onKeyDown}
    >
      <WorkerDockGlyph glyph={glyph} />
      <span
        key={title}
        data-worker-dock-pill-title=""
        className="min-w-0 truncate animate-in fade-in-0 duration-150 motion-reduce:animate-none"
      >
        {title}
      </span>
      {more > 0 ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">+{more}</span>
      ) : null}
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

/** While the card is open, Jump to latest rides 8px above it instead of hiding behind it. */
export function useWorkerDockJumpLift(card: RefObject<HTMLElement | null>, open: boolean): void {
  useLayoutEffect(() => {
    const element = card.current
    const pane = element?.closest<HTMLElement>('[data-native-chat-root]')
    if (!open || !element || !pane || typeof ResizeObserver === 'undefined') {
      return
    }
    const lift = () =>
      pane.style.setProperty(JUMP_LIFT, `calc(${PILL_ROOM} + ${element.offsetHeight + 8}px)`)
    const observer = new ResizeObserver(lift)
    observer.observe(element)
    lift()
    return () => {
      observer.disconnect()
      // Back over the pill, unless the pill already left and cleared both.
      if (pane.style.getPropertyValue('--native-chat-worker-pill-room')) {
        pane.style.setProperty(JUMP_LIFT, PILL_ROOM)
      }
    }
  }, [card, open])
}
