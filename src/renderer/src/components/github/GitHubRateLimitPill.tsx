/**
 * Compact GitHub API rate-limit indicator for the TaskPage header.
 *
 * Why: TaskPage fans out GitHub requests on every preset click, search
 * debounce, and repo-selection change (×N selected repos × 2 halves for
 * count). Users with large repo selections or heavy usage can exhaust the
 * search API's 30/min budget in a few clicks without knowing.
 *
 * Display policy: stay invisible during normal use. Only render when a
 * bucket drops to <25% remaining (warn) or <10% (crit). At healthy levels
 * the budget is not actionable information and surfacing it just trains
 * users to ignore the pill (or worry needlessly about ambiguous numbers
 * like "30/30"). The probe still runs in the background so we can show
 * the pill the moment something becomes actionable.
 *
 * This is an indicator, not a throttle — we deliberately don't block the
 * user from making requests when counts are low. Blocking would hurt the
 * hot path (well under quota) more than it helps the cold path (user can
 * also just wait for the reset, which is always < 1 hour).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Gauge } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { GetRateLimitResult, GitHubRateLimitSnapshot } from '../../../../shared/types'

// Why: 60s client-side cadence. Aligns with typical user action rhythm
// (click → paint → click) without polling faster than GitHub's counters
// move for typical request volumes. The server-side 30s cache absorbs
// any faster-than-this polling.
const REFRESH_INTERVAL_MS = 60_000

type BucketKey = 'core' | 'search' | 'graphql'

type BucketMeta = {
  key: BucketKey
  label: string
  description: string
}

const BUCKETS: BucketMeta[] = [
  { key: 'core', label: 'REST', description: 'REST API (5000/hr)' },
  { key: 'search', label: 'Search', description: 'Search API (30/min)' },
  { key: 'graphql', label: 'GraphQL', description: 'GraphQL (5000 pts/hr)' }
]

function formatReset(resetAt: number): string {
  // Why: resetAt is seconds, Date.now() is ms. Compute the gap in seconds so
  // "<1min" / "in 45s" / "in 12min" reads naturally without cognitive math.
  const deltaSec = Math.max(0, resetAt - Math.floor(Date.now() / 1000))
  if (deltaSec < 60) {
    return `${deltaSec}s`
  }
  const mins = Math.round(deltaSec / 60)
  return `${mins}m`
}

function toneFor(remaining: number, limit: number): 'ok' | 'warn' | 'crit' {
  if (limit <= 0) {
    return 'ok'
  }
  const pct = remaining / limit
  if (pct < 0.1) {
    return 'crit'
  }
  if (pct < 0.25) {
    return 'warn'
  }
  return 'ok'
}

function worstTone(snapshot: GitHubRateLimitSnapshot): 'ok' | 'warn' | 'crit' {
  const tones = BUCKETS.map((b) => toneFor(snapshot[b.key].remaining, snapshot[b.key].limit))
  if (tones.includes('crit')) {
    return 'crit'
  }
  if (tones.includes('warn')) {
    return 'warn'
  }
  return 'ok'
}

function tightestBucket(snapshot: GitHubRateLimitSnapshot): BucketMeta {
  // Why: "N left" in the pill shows the bucket closest to exhaustion by
  // ratio — that's the actionable one. Absolute remaining would always
  // favor GraphQL (5000 pts) over Search (30) even when Search is 1 away.
  let worst = BUCKETS[0]
  let worstPct = 1
  for (const b of BUCKETS) {
    const { remaining, limit } = snapshot[b.key]
    const pct = limit > 0 ? remaining / limit : 1
    if (pct < worstPct) {
      worstPct = pct
      worst = b
    }
  }
  return worst
}

export default function GitHubRateLimitPill(): React.JSX.Element | null {
  const [snapshot, setSnapshot] = useState<GitHubRateLimitSnapshot | null>(null)
  const [hasError, setHasError] = useState(false)
  // Why: StrictMode double-invokes effects in dev. Without this guard the
  // first mount fires two rate_limit IPCs back-to-back — benign (exempt
  // endpoint, cached) but noisy in logs. Tracks the latest in-flight token
  // so stale responses from an unmounted instance are dropped.
  const latestToken = useRef(0)

  const fetchSnapshot = useCallback(async (force: boolean): Promise<void> => {
    const token = ++latestToken.current
    try {
      const res = (await window.api.gh.rateLimit(force ? { force: true } : undefined)) as
        | GetRateLimitResult
        | undefined
      if (token !== latestToken.current) {
        return
      }
      if (res?.ok) {
        setSnapshot(res.snapshot)
        setHasError(false)
      } else {
        setHasError(true)
      }
    } catch {
      if (token !== latestToken.current) {
        return
      }
      setHasError(true)
    }
  }, [])

  useEffect(() => {
    void fetchSnapshot(false)
    const handle = window.setInterval(() => {
      void fetchSnapshot(false)
    }, REFRESH_INTERVAL_MS)
    return () => window.clearInterval(handle)
  }, [fetchSnapshot])

  // Why: silently render nothing on error or before first load. The pill is
  // informational — surfacing a red error here would mislead users into
  // thinking their actual gh workflow is broken when only the probe failed.
  if (!snapshot || hasError) {
    return null
  }

  const tone = worstTone(snapshot)
  // Why: hide the pill entirely at healthy levels. It only earns screen
  // real estate when the user is actually approaching a wall — otherwise
  // "30/30" is ambiguous noise that users can't act on.
  if (tone === 'ok') {
    return null
  }
  const tight = tightestBucket(snapshot)
  const tightBucket = snapshot[tight.key]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => void fetchSnapshot(true)}
          aria-label="GitHub rate limit"
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-md border px-1.5 text-[10px] font-medium transition',
            tone === 'crit' &&
              'border-red-500/40 bg-red-500/10 text-red-700 dark:text-red-300 hover:bg-red-500/20',
            tone === 'warn' &&
              'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300 hover:bg-amber-500/20'
          )}
        >
          <Gauge className="size-3" />
          <span>
            {/* Why: "N left" is unambiguous; "N/M" reads as either
                used-of-total or remaining-of-total depending on the user's
                prior. We only show this pill when low, so the count is
                already actionable — no need for the denominator here. */}
            {tightBucket.remaining} {tight.label.toLowerCase()} left · resets in{' '}
            {formatReset(tightBucket.resetAt)}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} className="text-xs">
        <div className="font-medium">GitHub API budget</div>
        <div className="mt-1 flex flex-col gap-0.5 font-mono">
          {BUCKETS.map((b) => {
            const v = snapshot[b.key]
            const t = toneFor(v.remaining, v.limit)
            return (
              <div key={b.key} className="flex items-center justify-between gap-3">
                <span>{b.description}</span>
                <span
                  className={cn(
                    t === 'crit' && 'text-red-400',
                    t === 'warn' && 'text-amber-400'
                  )}
                >
                  {v.remaining} of {v.limit} left · resets in {formatReset(v.resetAt)}
                </span>
              </div>
            )
          })}
        </div>
        <div className="mt-1 text-muted-foreground">Click to refresh</div>
      </TooltipContent>
    </Tooltip>
  )
}
