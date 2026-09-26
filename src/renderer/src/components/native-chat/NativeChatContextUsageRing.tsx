import { useCallback, useEffect, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  formatContextTokenCount,
  type NativeChatContextUsageSummary
} from './native-chat-context-usage-summary'

const RING_SIZE = 16
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
/** Past this the window is nearly spent; the ring turns destructive to say so. */
const CRITICAL_PERCENTAGE = 90
/** Long enough that a pointer crossing the ring toward dictation doesn't flash the card. */
const HOVER_OPEN_DELAY_MS = 150
/** Long enough for the pointer to cross the gap between the ring and the card. */
const HOVER_CLOSE_DELAY_MS = 100

type ContextUsageRow = NativeChatContextUsageSummary['rows'][number]

/** The CLI can repeat a category name, so a row's key counts which repeat it is. */
function keyRows(
  rows: NativeChatContextUsageSummary['rows']
): { key: string; row: ContextUsageRow }[] {
  const seen = new Map<string, number>()
  return rows.map((row) => {
    const repeat = seen.get(row.name) ?? 0
    seen.set(row.name, repeat + 1)
    return { key: `${repeat}:${row.name}`, row }
  })
}

/** Card open state where only mouse hover waits, to open and to close; any explicit change drops a pending hover. */
function useContextCardOpen(): {
  open: boolean
  setOpen: (next: boolean) => void
  setOpenAfterHover: (next: boolean) => void
} {
  const [open, setOpenState] = useState(false)
  const cancelPendingHover = useRef<(() => void) | null>(null)
  const dropPendingHover = useCallback((): void => {
    cancelPendingHover.current?.()
    cancelPendingHover.current = null
  }, [])
  useEffect(() => dropPendingHover, [dropPendingHover])
  const setOpen = useCallback(
    (next: boolean): void => {
      dropPendingHover()
      setOpenState(next)
    },
    [dropPendingHover]
  )
  const setOpenAfterHover = useCallback(
    (next: boolean): void => {
      dropPendingHover()
      // The card isn't mounted yet, so its own Escape handling can't cancel a pending open.
      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          dropPendingHover()
        }
      }
      const timer = setTimeout(
        () => setOpen(next),
        next ? HOVER_OPEN_DELAY_MS : HOVER_CLOSE_DELAY_MS
      )
      document.addEventListener('keydown', onKeyDown, true)
      cancelPendingHover.current = () => {
        clearTimeout(timer)
        document.removeEventListener('keydown', onKeyDown, true)
      }
    },
    [dropPendingHover, setOpen]
  )
  return { open, setOpen, setOpenAfterHover }
}

/** Composer ring for context-window usage; hover, click, tap, or Enter shows the provider's breakdown. */
export function NativeChatContextUsageRing({
  usage
}: {
  usage: NativeChatContextUsageSummary
}): React.JSX.Element {
  const filled = Math.min(Math.max(usage.percentage, 0), 100)
  const critical = usage.percentage >= CRITICAL_PERCENTAGE
  const used = formatContextTokenCount(usage.usedTokens)
  const window = formatContextTokenCount(usage.windowTokens)
  const label = translate(
    'components.native-chat.contextUsage.label',
    'Context {{used}} of {{window}} tokens, {{percent}}% used',
    { used, window, percent: String(usage.percentage) }
  )
  const { open, setOpen, setOpenAfterHover } = useContextCardOpen()
  const rows = keyRows(usage.rows)
  return (
    <div
      className="flex"
      // Touch fires pointerleave before its click, so only a mouse drives hover.
      // The portaled card is inside this element's React tree, so entering it cancels a pending close.
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') {
          setOpenAfterHover(true)
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') {
          setOpenAfterHover(false)
        }
      }}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            aria-expanded={open}
            data-native-chat-context-usage={usage.percentage}
            data-native-chat-context-usage-estimated={usage.estimated ? 'true' : undefined}
            className={cn(
              'flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11',
              critical && 'text-destructive'
            )}
            // A read-only readout: clicking it must not pull focus out of the composer.
            onMouseDown={(event) => event.preventDefault()}
            onClick={(event) => {
              // Open, never toggle: a hover already opened it, and a click must not close it.
              event.preventDefault()
              setOpen(true)
            }}
          >
            <svg
              width={RING_SIZE}
              height={RING_SIZE}
              viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
              aria-hidden="true"
              className="-rotate-90"
            >
              <circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth={RING_STROKE}
                className="opacity-25"
              />
              <circle
                cx={RING_SIZE / 2}
                cy={RING_SIZE / 2}
                r={RING_RADIUS}
                fill="none"
                stroke="currentColor"
                strokeWidth={RING_STROKE}
                strokeLinecap="round"
                strokeDasharray={RING_CIRCUMFERENCE}
                strokeDashoffset={RING_CIRCUMFERENCE * (1 - filled / 100)}
              />
            </svg>
          </button>
        </PopoverTrigger>
        <PopoverContent
          aria-label={label}
          side="top"
          align="end"
          sideOffset={8}
          className="w-72"
          onOpenAutoFocus={(event) => event.preventDefault()}
          // Closing on pointer leave or Escape would otherwise focus the ring and strand typing.
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div className="p-4">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="font-medium text-foreground">
                {translate('components.native-chat.contextUsage.title', 'Context')}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {used}/{window}
              </span>
            </div>
            <Progress value={filled} aria-label={label} className="mt-2 h-1.5" />
            {rows.length > 0 ? (
              <ul className="mt-3 space-y-1 text-xs">
                {rows.map(({ key, row }) => (
                  <li key={key} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate text-foreground">{row.name}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {row.percentage}%
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            {usage.estimated ? (
              <p className="mt-3 text-[11px] text-muted-foreground">
                {translate(
                  'components.native-chat.contextUsage.estimated',
                  'Estimated from the last response.'
                )}
              </p>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
