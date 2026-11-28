import { useTranslate } from '@/i18n/use-translate'
import {
  useEffect,
  useLayoutEffect,
  type KeyboardEvent,
  type ReactNode,
  type RefObject
} from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { cn } from '@/lib/class-names'
import { ChevronUp } from 'lucide-react'
import { WorkerDockGlyph } from './WorkerDockGlyph'
import type { WorkerDockGlyph as Glyph } from './worker-dock-card-order'

// Where Jump to latest rests while the open panel rises over the transcript: 8px above it.
const JUMP_LIFT = '--native-chat-worker-jump-lift'

// The chip's own row at the dock's top, so it never covers transcript text; the open panel rises
// from it over the transcript.
export const WORKER_DOCK_FLOAT_CLASS =
  'pointer-events-none relative z-20 flex h-[26px] shrink-0 flex-col [&:not(:last-child)]:mb-2 [[data-native-chat-dock-fit~=dock]_&]:h-auto'
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
  action,
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
  /** Drawn at the end of the open panel's header, beside the toggle. */
  action?: ReactNode
  onToggle: () => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  const t = useTranslate()
  // One wrapper either way, so the button keeps its place (and focus) as the chip becomes the header.
  return (
    <div
      className={
        expanded ? 'flex h-[30px] shrink-0 items-center gap-1 rounded-md bg-muted pr-1' : 'contents'
      }
    >
      <button
        ref={pill}
        type="button"
        data-worker-dock-pill=""
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        // Open, the header's own text names it; folded, the name starts with the chip's text.
        aria-label={
          expanded || total === 0
            ? undefined
            : t('components.native-chat.workerDock.chipLabel', '{{label}}, latest: {{title}}', {
                label,
                title: latest
              })
        }
        className={cn(
          'flex shrink-0 items-center gap-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          expanded
            ? 'h-full min-w-0 flex-1 rounded-md px-2.5 hover:bg-accent'
            : cn(
                WORKER_DOCK_SURFACE_CLASS,
                'h-[26px] w-fit max-w-full self-start rounded-full px-2.5 shadow-sm hover:bg-accent'
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
            <ChevronUp aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
          </>
        ) : (
          <>
            <WorkerDockGlyph glyph={glyph} chip />
            <span data-worker-dock-pill-title="" className="min-w-0 truncate">
              {label}
            </span>
          </>
        )}
      </button>
      {expanded ? action : null}
    </div>
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
    const dock = element?.closest<HTMLElement>('[data-native-chat-dock]')
    if (!open || !element || !pane || !dock || typeof ResizeObserver === 'undefined') {
      return
    }
    // The transcript, where Jump rests, ends at the dock's top; the panel rises past it.
    const lift = () =>
      pane.style.setProperty(
        JUMP_LIFT,
        `${dock.getBoundingClientRect().top - element.getBoundingClientRect().top + 8}px`
      )
    const observer = new ResizeObserver(lift)
    observer.observe(element)
    lift()
    return () => {
      observer.disconnect()
      pane.style.removeProperty(JUMP_LIFT)
    }
  }, [card, open])
}
