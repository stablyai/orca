import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Timer } from 'lucide-react'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { useShallow } from 'zustand/react/shallow'
import { usePromptCacheCountdownNow } from './prompt-cache-countdown-clock'
import {
  getMostUrgentPromptCacheStartedAt,
  getPromptCacheCountdownForPane,
  type PromptCacheCountdownSelection
} from './prompt-cache-timer-selection'

/**
 * The most-urgent cache start time when a countdown should show, else null.
 * The worktree card uses it to both gate its metadata row and feed CacheTimer,
 * so neither the card nor the timer subscribes twice to the same store slices.
 *
 * When a worktree has multiple Claude tabs, this resolves the *most urgent*
 * (shortest remaining) start time — if any tab's cache is about to expire, the
 * user should know.
 */
export function usePromptCacheCountdownStartedAt(worktreeId: string, active = true): number | null {
  const [enabled, ttlMs, startedAt] = useAppStore(
    useShallow((s) => {
      if (!active) {
        return [false, 0, null] as const
      }
      const enabled = s.settings?.promptCacheTimerEnabled ?? false
      const ttlMs = s.settings?.promptCacheTtlMs ?? 0
      if (!enabled || ttlMs <= 0) {
        return [enabled, ttlMs, null] as const
      }
      return [
        enabled,
        ttlMs,
        getMostUrgentPromptCacheStartedAt(s.tabsByWorktree[worktreeId], s.cacheTimerByKey)
      ] as const
    })
  )
  return enabled && ttlMs > 0 && startedAt != null ? startedAt : null
}

export function usePromptCacheCountdownForPane(
  paneKey: string,
  active = true
): PromptCacheCountdownSelection | null {
  return useAppStore(
    useShallow((s) => {
      if (!active || !(s.settings?.promptCacheTimerEnabled ?? false)) {
        return null
      }
      return getPromptCacheCountdownForPane(
        paneKey,
        s.cacheTimerByKey,
        s.settings?.promptCacheTtlMs ?? 0
      )
    })
  )
}

/**
 * Per-worktree prompt-cache countdown, shown in the sidebar worktree card. The
 * card renders this only once a cache is active, so it's a pure countdown view.
 *
 * Why: prompt caching (Anthropic API / Bedrock) has a TTL (default 5 min).
 * When the cache expires, the next request re-sends the full conversation as
 * uncached input tokens — up to 10x more expensive. Showing a countdown lets
 * users decide whether to resume interaction before the cache drops.
 */
export default function CacheTimer({
  startedAt,
  ttlMs
}: {
  startedAt: number
  ttlMs: number
}): React.JSX.Element {
  const now = usePromptCacheCountdownNow(true)
  const remainingMs = Math.max(0, ttlMs - (now - startedAt))

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
          {/* When expired, the red icon alone conveys state — the countdown
              text is only meaningful while the cache is still alive. */}
          {!expired && <span>{label}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span>{tooltipText}</span>
      </TooltipContent>
    </Tooltip>
  )
}
