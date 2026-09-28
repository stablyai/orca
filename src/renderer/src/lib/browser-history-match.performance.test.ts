import { describe, expect, it } from 'vitest'
import { BROWSER_HISTORY_MATCH_BUDGET } from './browser-history-match-budget'
import { matchBrowserHistory, prepareBrowserHistoryEntries } from './browser-history-match'
import { MAX_BROWSER_HISTORY_ENTRIES } from '../../../shared/workspace-session-browser-history'
import type { BrowserHistoryEntry } from '../../../shared/browser-workspace-types'

const { candidateCount, matchMs, prepareMs } = BROWSER_HISTORY_MATCH_BUDGET

const LONG_PATH =
  'engineering/platform/runtime/observability/dashboards/incident-review/2026-08-27/rollout'

function makeEntry(index: number): BrowserHistoryEntry {
  const url = `https://service-${index % 23}.internal.example.com/${LONG_PATH}/${index}?tab=overview&window=7d&team=platform#section-${index % 9}`
  return {
    url,
    normalizedUrl: url,
    title: `Incident review ${index} — platform runtime observability rollout status`,
    lastVisitedAt: Date.now() - index * 60_000,
    visitCount: index % 140
  }
}

const entries = Array.from({ length: candidateCount }, (_, index) => makeEntry(index))
// The worst realistic query: matches nothing early, so every entry is scanned in full.
const WORST_QUERY = 'observability rollout'

/**
 * Why the lower quartile and not p95 or the minimum: this runs in a vitest worker
 * competing for cores with the rest of the suite, so a slow sample records a
 * preemption rather than the matcher, while a single fastest sample would pass
 * with the other 19 runs over budget. Requiring a quarter of the batch inside the
 * ceiling still discards the preempted tail: measured for preparation, the lower
 * quartile moved 0.07 ms -> 0.15 ms between idle and 4x core oversubscription,
 * while p95 of those same batches swung 0.10 ms -> 0.81 ms and the slowest sample
 * reached 6.9 ms.
 */
function lowerQuartileSample(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  // Nearest-rank p25: ceil(n*0.25)-1, so 20 samples pick the 5th fastest.
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.25) - 1)]
}

describe('browser history match performance budget', () => {
  // Why assert the constant: raising the store cap must fail here until the
  // budget is re-measured, which a comment on the field would not do.
  it('tracks the store cap the budget was measured against', () => {
    expect(candidateCount).toBe(MAX_BROWSER_HISTORY_ENTRIES)
  })

  it('prepares a cold corpus within budget', () => {
    prepareBrowserHistoryEntries(entries)
    const samples: number[] = []
    for (let run = 0; run < 20; run += 1) {
      const start = performance.now()
      // Use a fresh array identity so this measures preparation rather than
      // the identity cache used by live address bars and omniboxes.
      prepareBrowserHistoryEntries(entries.slice())
      samples.push(performance.now() - start)
    }
    expect(lowerQuartileSample(samples)).toBeLessThan(prepareMs)
  })

  it('matches one query against the prepared corpus within budget', () => {
    const prepared = prepareBrowserHistoryEntries(entries)
    const run = (): void => {
      matchBrowserHistory({ prepared, query: WORST_QUERY, limit: 3 })
    }
    // Warm the matcher before timing so JIT compilation is not part of the samples.
    run()
    const samples: number[] = []
    for (let index = 0; index < 20; index += 1) {
      const start = performance.now()
      run()
      samples.push(performance.now() - start)
    }
    expect(lowerQuartileSample(samples)).toBeLessThan(matchMs)
  })
})
