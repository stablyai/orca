import { useTranslate } from '@/i18n/use-translate'
import type { RefObject } from 'react'
import { Bot, ChevronDown, CircleAlert, CircleHelp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'

export function WorkerDockHeader({
  narrow,
  expanded,
  incomplete,
  count,
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
  return (
    <div
      data-worker-dock-header=""
      className={cn('flex shrink-0 items-center gap-1 pr-2', narrow ? 'min-h-11' : 'min-h-9')}
    >
      <button
        ref={summary}
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg pl-3 pr-2 sm:pl-4 text-left text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => {
          onToggle()
        }}
      >
        {failed > 0 ? (
          <CircleAlert
            aria-hidden="true"
            data-worker-dock-failed=""
            className="size-4 shrink-0 text-destructive"
          />
        ) : needsYou > 0 ? (
          <CircleHelp
            aria-hidden="true"
            data-worker-dock-urgent=""
            className="size-4 shrink-0 text-chat-warning"
          />
        ) : (
          <Bot aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">
          {count ||
            (incomplete
              ? t('components.native-chat.workerDock.unavailable', 'Worker status unavailable')
              : t('components.native-chat.workerDock.empty', '0 workers'))}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn('size-3 shrink-0', expanded && 'rotate-180')}
        />
      </button>
      {expanded && stopAll ? (
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
      {expanded && clearable >= 2 ? (
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
