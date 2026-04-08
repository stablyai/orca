import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Timer } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'

/**
 * Per-worktree prompt-cache countdown, shown in the sidebar worktree card.
 *
 * When a worktree has multiple Claude tabs, the timer shows the *most urgent*
 * (shortest remaining) countdown — if any tab's cache is about to expire, the
 * user should know.
 *
 * Why: prompt caching (Anthropic API / Bedrock) has a TTL (default 5 min).
 * When the cache expires, the next request re-sends the full conversation as
 * uncached input tokens — up to 10x more expensive. Showing a countdown lets
 * users decide whether to resume interaction before the cache drops.
 */
export default function CacheTimer({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const enabled = useAppStore((s) => s.settings?.promptCacheTimerEnabled ?? false)
  const ttlMs = useAppStore((s) => s.settings?.promptCacheTtlMs ?? 0)

  // Find the most urgent (minimum remaining) cache timer across all panes in this worktree.
  const mostUrgentStartedAt = useAppStore((s) => {
    const tabs = s.tabsByWorktree[worktreeId]
    if (!tabs) {
      return null
    }
    let oldest: number | null = null
    for (const tab of tabs) {
      // Why: cache timer keys are `${tabId}:${paneId}` composites, so we check
      // all keys that belong to this tab's panes.
      for (const key of Object.keys(s.cacheTimerByKey)) {
        if (!key.startsWith(`${tab.id}:`)) {
          continue
        }
        const ts = s.cacheTimerByKey[key]
        if (ts != null && (oldest === null || ts < oldest)) {
          // Why: smaller startedAt = started earlier = more elapsed time = less remaining = more urgent.
          oldest = ts
        }
      }
    }
    return oldest
  })

  const [remainingMs, setRemainingMs] = useState<number | null>(null)

  useEffect(() => {
    if (!enabled || !mostUrgentStartedAt || ttlMs <= 0) {
      setRemainingMs(null)
      return
    }

    const tick = (): void => {
      const elapsed = Date.now() - mostUrgentStartedAt
      const remaining = Math.max(0, ttlMs - elapsed)
      setRemainingMs(remaining)
    }

    tick()
    const interval = setInterval(tick, 1000)
    return () => clearInterval(interval)
  }, [enabled, mostUrgentStartedAt, ttlMs])

  if (remainingMs === null) {
    return null
  }

  const totalSeconds = Math.ceil(remainingMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  const label = `${minutes}:${seconds.toString().padStart(2, '0')}`

  const expired = remainingMs === 0
  const warning = !expired && remainingMs <= 60_000

  const tooltipText = expired
    ? 'The next message will re-send the full context as uncached tokens'
    : `Prompt cache expires in ${label}`

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            'inline-flex items-center gap-1 text-[10px] font-mono tabular-nums select-none leading-none',
            expired ? 'text-red-400' : warning ? 'text-yellow-400' : 'text-muted-foreground'
          )}
        >
          <Timer className="size-2.5" />
          <span>{expired ? 'expired' : label}</span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span>{tooltipText}</span>
      </TooltipContent>
    </Tooltip>
  )
}
