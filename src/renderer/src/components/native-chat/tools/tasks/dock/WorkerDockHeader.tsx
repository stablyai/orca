import { useTranslate } from '@/i18n/use-translate'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useWorkerDockGestureHeld } from './NativeChatWorkerDockFrame'
import { Bot, ChevronDown, CircleAlert, CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'

export function WorkerDockHeader({
  narrow,
  expanded,
  incomplete,
  count,
  total,
  clearable,
  failed,
  needsYou,
  clearing,
  listId,
  summary,
  onToggle,
  onClear,
  stopAll
}: {
  narrow: boolean
  expanded: boolean
  incomplete?: boolean
  count: string
  total: number
  /** Failed rows Clear all acknowledges: settled and owned here. */
  clearable: number
  failed: number
  needsYou: number
  clearing: boolean
  listId: string
  summary: RefObject<HTMLButtonElement | null>
  onToggle: () => void
  onClear: () => void
  stopAll?: { pending: boolean; onStop: () => void }
}) {
  const t = useTranslate()
  const held = useWorkerDockGestureHeld()
  const header = useRef<HTMLDivElement>(null)
  const [heldHeight, setHeldHeight] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (!held) {
      setHeldHeight(header.current?.getBoundingClientRect().height)
    }
  }, [held, count, narrow])
  return (
    <div
      ref={header}
      data-worker-dock-header=""
      style={
        held && heldHeight
          ? { height: heldHeight, minHeight: heldHeight, overflow: 'hidden' }
          : undefined
      }
      className={cn(
        'sticky top-0 z-10 flex shrink-0 items-center gap-1 bg-muted px-2 pr-8',
        narrow ? 'min-h-11' : 'h-8'
      )}
    >
      <button
        ref={summary}
        type="button"
        aria-label={
          count ||
          (incomplete
            ? t('components.native-chat.workerDock.unavailable', 'Worker status unavailable')
            : t('components.native-chat.workerDock.empty', '0 workers'))
        }
        aria-expanded={expanded}
        aria-controls={listId}
        className="flex min-h-8 min-w-0 flex-1 items-center px-2 text-left text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => {
          onToggle()
        }}
      >
        {needsYou > 0 ? (
          <CircleHelp
            aria-hidden="true"
            data-worker-dock-urgent=""
            className="mr-2 size-4 shrink-0 text-chat-warning"
          />
        ) : failed > 0 ? (
          <CircleAlert
            aria-hidden="true"
            data-worker-dock-failed=""
            className="mr-2 size-4 shrink-0 text-destructive"
          />
        ) : (
          <Bot aria-hidden="true" className="mr-2 size-4 shrink-0 text-muted-foreground" />
        )}
        <span>
          {count ||
            (incomplete
              ? t('components.native-chat.workerDock.unavailable', 'Worker status unavailable')
              : t('components.native-chat.workerDock.empty', '0 workers'))}
          {incomplete && total > 0
            ? t(
                'components.native-chat.workerDock.partial',
                ' · {{count}} shown · total unavailable',
                { count: total }
              )
            : ''}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn('pointer-events-none absolute right-3 size-3', expanded && 'rotate-180')}
        />
      </button>
      {stopAll ? (
        <Button
          variant="ghost"
          size="xs"
          aria-disabled={stopAll.pending}
          onClick={() => {
            if (!stopAll.pending) {
              stopAll.onStop()
            }
          }}
        >
          {stopAll.pending
            ? t('components.native-chat.workerDock.stopping', 'Stopping…')
            : t('components.native-chat.workerDock.stop', 'Stop')}
        </Button>
      ) : null}
      {clearable >= 2 ? (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={t(
            'components.native-chat.workerDock.clearAllLabel',
            'Clear all {{count}} failed workers',
            { count: clearable, defaultValue_one: 'Clear failed worker' }
          )}
          aria-disabled={clearing}
          onClick={() => {
            if (clearing) {
              return
            }
            onClear()
            summary.current?.focus()
          }}
        >
          {t('components.native-chat.workerDock.clearAll', 'Clear all')}
        </Button>
      ) : null}
    </div>
  )
}
