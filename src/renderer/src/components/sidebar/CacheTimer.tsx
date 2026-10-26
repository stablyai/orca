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

/** Resolve the soonest-expiring Claude cache once for both row visibility and countdown rendering. */
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

/** Expose cache expiry so users can resume before uncached conversation input increases cost. */
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
          {!expired && <span>{label}</span>}
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8}>
        <span>{tooltipText}</span>
      </TooltipContent>
    </Tooltip>
  )
}
