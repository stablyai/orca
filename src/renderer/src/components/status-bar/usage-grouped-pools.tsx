import React from 'react'
import type { RateLimitBucket } from '../../../../shared/rate-limit-types'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import {
  formatPoolGroupLabel,
  formatPoolWindowLabel,
  type GroupedUsagePool
} from './usage-pool-label'
import { formatBareUsagePercentage } from './usage-percentage-label'

// Shortest window first; an unknown window (0) sorts last. Stable, so ties keep agy's order.
function compareWindows(a: RateLimitBucket, b: RateLimitBucket): number {
  if (a.windowMinutes === b.windowMinutes) {
    return 0
  }
  if (a.windowMinutes === 0) {
    return 1
  }
  if (b.windowMinutes === 0) {
    return -1
  }
  return a.windowMinutes - b.windowMinutes
}

// Why not `name`: it repeats when agy omits bucket names, so key by length and its occurrence count.
function keyedWindows(
  buckets: readonly RateLimitBucket[]
): { bucket: RateLimitBucket; key: string }[] {
  const seen = new Map<number, number>()
  return [...buckets].sort(compareWindows).map((bucket) => {
    const occurrence = seen.get(bucket.windowMinutes) ?? 0
    seen.set(bucket.windowMinutes, occurrence + 1)
    return { bucket, key: `${bucket.windowMinutes}:${occurrence}` }
  })
}

/** Model-group pools as "Gemini 0% 5h · 4% wk │ Claude/GPT …"; children are flex items of the segment row. */
export function GroupedPoolUsage({
  visibleBuckets,
  allBuckets,
  display,
  now
}: {
  visibleBuckets: readonly GroupedUsagePool[]
  allBuckets: readonly RateLimitBucket[]
  display: UsagePercentageDisplay
  now: number
}): React.JSX.Element {
  const groups = new Map<string, RateLimitBucket[]>()
  for (const bucket of visibleBuckets) {
    const buckets = groups.get(bucket.group) ?? []
    buckets.push(bucket)
    groups.set(bucket.group, buckets)
  }
  return (
    <>
      {[...groups].map(([group, buckets], groupIndex) => {
        const windows = keyedWindows(buckets)
        return (
          <React.Fragment key={group}>
            {groupIndex > 0 ? (
              <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
            ) : null}
            <span className="max-w-[120px] truncate" title={group}>
              {formatPoolGroupLabel(group, allBuckets)}
            </span>
            {windows.map(({ bucket, key }, index) => {
              const percentage = formatBareUsagePercentage(bucket.usedPercent, display)
              const window = formatPoolWindowLabel(bucket, now)
              return (
                <React.Fragment key={key}>
                  {index > 0 ? <span className="text-muted-foreground">·</span> : null}
                  <span className="tabular-nums">{`${percentage} ${window}`.trim()}</span>
                </React.Fragment>
              )
            })}
          </React.Fragment>
        )
      })}
    </>
  )
}
