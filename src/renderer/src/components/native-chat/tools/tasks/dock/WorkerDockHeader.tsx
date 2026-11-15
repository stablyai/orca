import { useTranslate } from '@/i18n/use-translate'
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useWorkerDockGestureHeld } from './NativeChatWorkerDockFrame'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'

export function WorkerDockHeader({
  narrow,
  expanded,
  incomplete,
  count,
  total,
  failures,
  clearUnavailable,
  clearing,
  listId,
  summary,
  onToggle,
  onClear
}: {
  narrow: boolean
  expanded: boolean
  incomplete?: boolean
  count: string
  total: number
  failures: number
  clearing: boolean
  clearUnavailable: boolean
  listId: string
  summary: RefObject<HTMLButtonElement | null>
  onToggle: () => void
  onClear: () => void
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
      style={
        held && heldHeight
          ? { height: heldHeight, minHeight: heldHeight, overflow: 'hidden' }
          : undefined
      }
      className={cn('relative flex items-center gap-1 px-2 pr-8', narrow ? 'min-h-11' : 'h-8')}
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
      {failures >= 2 ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label={t(
                'components.native-chat.workerDock.clearAllLabel',
                'Clear all {{count}} failed workers',
                { count: failures, defaultValue_one: 'Clear failed worker' }
              )}
              aria-disabled={clearUnavailable || clearing}
              onClick={() => {
                if (clearUnavailable || clearing) {
                  return
                }
                onClear()
                summary.current?.focus()
              }}
            >
              {t('components.native-chat.workerDock.clearAll', 'Clear all')}
            </Button>
          </TooltipTrigger>
          {clearUnavailable ? (
            <TooltipContent>
              {t(
                'components.native-chat.workerDock.remoteOwner',
                'Stop or clear this from the computer it runs on'
              )}
            </TooltipContent>
          ) : null}
        </Tooltip>
      ) : null}
    </div>
  )
}
