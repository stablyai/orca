import { useCallback, useEffect, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Progress } from '@/components/ui/progress'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  contextUsageRingReadout,
  formatContextTokenCount,
  keyContextUsageRows,
  type NativeChatContextUsageSummary
} from '../../../../../shared/native-chat/native-chat-context-usage-summary'

const RING_SIZE = 16
const RING_STROKE = 2
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS
/** Long enough that a pointer crossing the ring toward dictation doesn't flash the card. */
const HOVER_OPEN_DELAY_MS = 150
/** Long enough for the pointer to cross the gap between the ring and the card. */
const HOVER_CLOSE_DELAY_MS = 100

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

/** Deferred rows sit outside the window, so they show tokens rather than a share of it. */
function ContextUsageRowList({
  rows,
  className
}: {
  rows: ReturnType<typeof keyContextUsageRows>
  className: string
}): React.JSX.Element {
  return (
    <ul className={cn('space-y-1 text-xs', className)}>
      {rows.map(({ key, row }) => (
        <li key={key} className="flex items-baseline justify-between gap-3">
          <span
            className={cn(
              'min-w-0 truncate',
              row.deferred ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {row.name}
          </span>
          <span className="shrink-0 tabular-nums text-muted-foreground">
            {row.deferred ? formatContextTokenCount(row.tokens) : `${row.percentage}%`}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Composer ring for context-window usage; hover, click, tap, or Enter shows the provider's breakdown. */
export function NativeChatContextUsageRing({
  usage
}: {
  usage: NativeChatContextUsageSummary
}): React.JSX.Element {
  const t = useTranslate()
  const { filled, critical, used, window } = contextUsageRingReadout(usage)
  const label = t(
    'components.native-chat.contextUsage.label',
    'Context {{used}} of {{window}} tokens, {{percent}}% used',
    { used, window, percent: String(usage.percentage) }
  )
  const { open, setOpen, setOpenAfterHover } = useContextCardOpen()
  const rows = keyContextUsageRows(usage.rows)
  const counted = rows.filter(({ row }) => !row.deferred)
  const deferred = rows.filter(({ row }) => row.deferred)
  return (
    <div
      className="flex"
      // Only mouse hover drives delays; touch leaves before click, and portal entry must cancel pending close.
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
      onContextMenu={() => setOpen(false)}
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
              'flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11',
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
                {t('components.native-chat.contextUsage.title', 'Context')}
              </span>
              <span className="tabular-nums text-muted-foreground">
                {used}/{window}
              </span>
            </div>
            <Progress value={filled} aria-label={label} className="mt-2 h-1.5" />
            {counted.length > 0 ? <ContextUsageRowList rows={counted} className="mt-3" /> : null}
            {deferred.length > 0 ? (
              <div className="mt-3 border-t border-border pt-3">
                <p className="text-2xs text-muted-foreground">
                  {t(
                    'components.native-chat.contextUsage.deferredNote',
                    'Loaded on demand. Not counted in the used total.'
                  )}
                </p>
                <ContextUsageRowList rows={deferred} className="mt-2" />
              </div>
            ) : null}
            {usage.estimated ? (
              <p className="mt-3 text-2xs text-muted-foreground">
                {t(
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
