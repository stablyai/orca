import { useTranslate } from '@/i18n/use-translate'
import {
  useEffect,
  useLayoutEffect,
  type KeyboardEvent,
  type ReactNode,
  type MouseEvent,
  type RefObject
} from 'react'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { cn } from '@/lib/class-names'
import { WorkerDockGlyph } from './WorkerDockGlyph'
import { workerChipAnchor } from './worker-chip-slot'
import type { WorkerDockGlyph as Glyph } from './worker-dock-card-order'

// Where Jump to latest rests while the open panel rises over the transcript: 8px above it.
const JUMP_LIFT = '--native-chat-worker-jump-lift'

// A zero-height row at the transcript's end: the chip sits on it, over the transcript (which keeps
// room for it at its end), and the open panel rises from there.
export const WORKER_DOCK_FLOAT_CLASS = 'pointer-events-none relative h-0 shrink-0'
/** The folded chip's row height. */
export const WORKER_DOCK_CHIP_ROW = 24
// The chip's footprint over the transcript's end: the transcript pads its end by this, so its last
// line still clears the chip.
const CHIP_ROOM = '--native-chat-worker-chip-room'
// The transcript's least height while the chip shows, kept even when the dock takes its floor.
const CHIP_FLOOR = '--native-chat-worker-chip-floor'
// Raised over the transcript, opaque even when the chat's message-box surface is translucent.
export const WORKER_DOCK_SURFACE_CLASS =
  'pointer-events-auto border border-border bg-chat-canvas bg-[linear-gradient(var(--color-chat-composer-surface),var(--color-chat-composer-surface))] text-foreground'

/** The chip's one dot: the worst state among the workers. Red needs you, the dot grid while
 *  work runs, yellow waiting, green done; false (nothing could be read) is a grey ring. */
function WorkerDockChipDot({ glyph, terminal }: { glyph: Glyph | false; terminal: boolean }) {
  if (glyph === 'running') {
    return <WorkerDockGlyph glyph="running" chip terminal={terminal} />
  }
  return (
    <span aria-hidden="true" className="inline-flex size-3 shrink-0 items-center justify-center">
      <span
        className={cn(
          'block size-2 rounded-full',
          (glyph === 'ask' || glyph === 'failed') && 'bg-destructive',
          glyph === 'queued' && 'bg-status-warning',
          glyph === 'done' && 'bg-status-success',
          glyph === false && 'border-[1.5px] border-muted-foreground'
        )}
      />
    </span>
  )
}

/** The chip's text. Short of room (the open header beside its actions), what needs you or runs
 *  ("2 needs you") stays whole and the worker count after it ("· 5 workers") drops out whole, onto a
 *  hidden second line, rather than being cut to a dangling "·…"; a lone worker's title truncates. */
function WorkerDockChipLabel({ label, titled }: { label: string; titled: boolean }) {
  const [lead, ...rest] = titled ? [label] : label.split(' · ')
  return (
    <span data-worker-dock-pill-title="" className="flex h-[1lh] min-w-0 flex-wrap overflow-hidden">
      <span className={rest.length ? 'shrink-0' : 'min-w-0 truncate'}>{lead}</span>
      {/* A no-break space: a plain one would collapse at the item's edge. */}
      {rest.length ? <span className="shrink-0">{`\u00a0· ${rest.join(' · ')}`}</span> : null}
    </span>
  )
}

/** The worker chip ("3 running"). Open, the same chip (one button, so focus stays put) heads the
 *  list: its dot and text sit left, in line with the rows' marks and titles, and the bulk actions
 *  sit at its right. */
export function WorkerDockPill({
  pill,
  glyph,
  label,
  spokenLabel = label,
  titled = false,
  commandsOnly = false,
  latest,
  total,
  expanded,
  listId,
  action,
  onToggle,
  onEnterList
}: {
  pill: RefObject<HTMLButtonElement | null>
  glyph: Glyph | false
  /** The chip's text: the one worker's title, how many run or need you, or what is known. */
  label: string
  /** The chip's count for assistive technology, both groups in full. */
  spokenLabel?: string
  /** The label is a worker's own title: drawn whole (truncated), never split at a " · ". */
  titled?: boolean
  /** Only background commands are listed: the running chip draws a terminal, not the worker grid. */
  commandsOnly?: boolean
  /** The most relevant worker's title, for assistive technology. */
  latest: string
  total: number
  expanded: boolean
  listId: string
  /** The open list's bulk actions, at the header's right. */
  action: ReactNode
  onToggle: (event: MouseEvent<HTMLButtonElement>) => void
  /** Moves focus into the open list's first row. */
  onEnterList: () => void
}) {
  const t = useTranslate()
  return (
    <div
      className={cn(
        'group/dock-header flex shrink-0 items-center border-b transition-[border-color] duration-[280ms] ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none',
        // Open, as tall as a row (32px, taller only if a long Stop label wraps) and a width container
        // for its actions; folded, 24px and no container (one would give the chip no width). Its
        // height steps at once: the list's own growth carries the motion, and what reads the
        // header's height (the card budget, Jump's lift) reads it once, not every frame.
        expanded
          ? '@container/dock-header h-auto min-h-8 gap-1 rounded-t-[inherit] border-border has-[[data-worker-dock-actions]]:pr-1.5'
          : 'h-6 min-h-6 rounded-[inherit] border-transparent'
      )}
    >
      <button
        ref={pill}
        type="button"
        data-worker-dock-pill=""
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        // A lone worker's chip is its title, which already names it.
        aria-label={
          total === 0 || label === latest
            ? undefined
            : t('components.native-chat.workerDock.chipLabel', '{{label}}, latest: {{title}}', {
                label: spokenLabel,
                title: latest
              })
        }
        className={cn(
          'flex min-w-0 items-center self-stretch rounded-[inherit] text-xs whitespace-nowrap hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
          // Open, the list's 4px inset plus a row's 8px puts the dot over the rows' marks.
          // Open, it takes its text's width and gives way first, down to room for its label's lead
          // ("12 needs you"); only then do the actions beside it wrap.
          expanded
            ? // Beside the actions, its right corners are square; only the card's top-left is its own.
              'min-w-[7.5rem] shrink-[10000] grow justify-start gap-2 pr-2 pl-3 group-has-[[data-worker-dock-actions]]/dock-header:rounded-r-none'
            : 'flex-1 justify-center gap-1.5 px-2.5'
        )}
        onClick={onToggle}
        onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
          // The open chip heads the list, so down moves into its first row.
          if (expanded && event.key === 'ArrowDown') {
            event.preventDefault()
            onEnterList()
          }
        }}
      >
        <WorkerDockChipDot glyph={glyph} terminal={commandsOnly} />
        <WorkerDockChipLabel label={label} titled={titled} />
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
      // A dialog in another pane's chat (its subagent sheet) is outside too.
      const keeper = target.closest(KEEPS_CARD_OPEN)
      const keeperPane = keeper?.closest('[data-native-chat-root]')
      if (!ownJump && !(keeper && (!keeperPane || keeperPane === pane))) {
        fold()
      }
    }
    document.addEventListener('pointerdown', press, true)
    return () => document.removeEventListener('pointerdown', press, true)
  }, [root, open, fold])
}

/** Where the chip's settings live: the main transcript's own column (the message list holding the
 *  transcript, the chip's row and the task list), so a subagent sheet in the same pane gets none. */
export function workerDockScope(row: Element | null | undefined): HTMLElement | null {
  return workerChipAnchor(row)?.parentElement ?? null
}

/** While the chip shows, the transcript keeps room for it at its end and Jump to latest rests 12px
 *  above it; while the panel is open, and until it has folded, 8px above where the panel ends up
 *  rather than hiding behind it. The pane keeps the transcript at least the chip's height when the
 *  dock takes its floor. Read from the chip's row and the settled parts (borders, header, list),
 *  again only when the header or list changes height: a long Stop label can wrap while the shape is
 *  still narrow, so the header is re-read once it settles. */
export function useWorkerDockJumpLift({
  root,
  card,
  content,
  shown,
  open,
  placement
}: {
  root: RefObject<HTMLElement | null>
  card: RefObject<HTMLElement | null>
  content: RefObject<HTMLElement | null>
  shown: boolean
  open: boolean
  /** The slot the chip draws in: moved to another, it measures again there. */
  placement: HTMLElement | null
}): void {
  useLayoutEffect(() => {
    const row = root.current
    const element = card.current
    const header = element?.firstElementChild
    const scope = workerDockScope(row)
    const pane = element?.closest<HTMLElement>('[data-native-chat-root]')
    if (
      !shown ||
      !row ||
      !element ||
      !(header instanceof HTMLElement) ||
      !scope ||
      !pane ||
      typeof ResizeObserver === 'undefined'
    ) {
      return
    }
    const list = open ? content.current : null
    const place = () => {
      const borders = element.offsetHeight - element.clientHeight
      const folded = borders + WORKER_DOCK_CHIP_ROW
      const full = list ? borders + header.offsetHeight + list.offsetHeight : folded
      const above = Math.max(
        0,
        row.getBoundingClientRect().top - element.getBoundingClientRect().bottom
      )
      scope.style.setProperty(CHIP_ROOM, `${above + folded}px`)
      // Jump keeps its 12px rest above the chip, and 8px above the open panel.
      scope.style.setProperty(JUMP_LIFT, `${above + full + (list ? 8 : 12)}px`)
      pane.style.setProperty(CHIP_FLOOR, `${above + folded}px`)
    }
    const observer = workerDockHeightObserver(place)
    observer.observe(header)
    if (list) {
      observer.observe(list)
    }
    place()
    return () => {
      observer.disconnect()
      scope.style.removeProperty(CHIP_ROOM)
      scope.style.removeProperty(JUMP_LIFT)
      pane.style.removeProperty(CHIP_FLOOR)
    }
  }, [root, card, content, shown, open, placement])
}

/** A ResizeObserver that calls `onHeight` only when an observed element's height changes. */
export function workerDockHeightObserver(onHeight: () => void): ResizeObserver {
  const heights = new Map<Element, number>()
  return new ResizeObserver((entries) => {
    let changed = false
    for (const entry of entries) {
      const height = entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height
      changed = changed || heights.get(entry.target) !== height
      heights.set(entry.target, height)
    }
    if (changed) {
      onHeight()
    }
  })
}
