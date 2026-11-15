import { useRef, type RefObject } from 'react'
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
  const held = useWorkerDockGestureHeld()
  const header = useRef<HTMLDivElement>(null)
  const heldHeight = useRef<number | undefined>(undefined)
  if (!held) {
    heldHeight.current = header.current?.getBoundingClientRect().height
  }
  return (
    <div
      ref={header}
      style={
        held && heldHeight.current
          ? { height: heldHeight.current, minHeight: heldHeight.current, overflow: 'hidden' }
          : undefined
      }
      className={cn('relative flex items-center gap-1 px-2 pr-8', narrow ? 'min-h-11' : 'h-8')}
    >
      <button
        ref={summary}
        type="button"
        aria-label={count || (incomplete ? 'Worker status unavailable' : '0 workers')}
        aria-expanded={expanded}
        aria-controls={listId}
        className="flex min-h-8 min-w-0 flex-1 items-center px-2 text-left text-xs font-medium text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        onClick={() => {
          onToggle()
        }}
      >
        <span>
          {count || (incomplete ? 'Worker status unavailable' : '0 workers')}
          {incomplete && total > 0 ? ` · ${total} shown · total unavailable` : ''}
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
              aria-label={`Clear all ${failures} failed workers`}
              aria-disabled={clearUnavailable || clearing}
              onClick={() => {
                if (clearUnavailable || clearing) {
                  return
                }
                onClear()
                summary.current?.focus()
              }}
            >
              Clear all
            </Button>
          </TooltipTrigger>
          {clearUnavailable ? (
            <TooltipContent>Stop or clear this from the computer it runs on</TooltipContent>
          ) : null}
        </Tooltip>
      ) : null}
    </div>
  )
}
