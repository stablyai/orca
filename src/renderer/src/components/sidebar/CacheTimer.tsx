import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Timer } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { usePromptCacheCountdownNow } from './prompt-cache-countdown-clock'
import { getMostUrgentPromptCacheStartedAt } from './prompt-cache-timer-selection'

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

  const mostUrgentStartedAt = useAppStore((s) => {
    return getMostUrgentPromptCacheStartedAt(s.tabsByWorktree[worktreeId], s.cacheTimerByKey)
  })

  const countdownActive = enabled && mostUrgentStartedAt != null && ttlMs > 0
  const now = usePromptCacheCountdownNow(countdownActive)
  const remainingMs = countdownActive ? Math.max(0, ttlMs - (now - mostUrgentStartedAt)) : null

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
