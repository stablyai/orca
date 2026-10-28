import { useEffect, useState } from 'react'
import type { UsageRange } from '../../../../shared/usage-range'
import type { UsageOverviewInput } from './usage-overview-types'

/** Reads enabled providers' cached snapshots without changing their detail-page range or scope. */
export async function queryUsageOverviewRange(
  input: UsageOverviewInput,
  range: UsageRange
): Promise<UsageOverviewInput> {
  const [claude, codex, opencode, muse] = await Promise.all([
    input.claude.scanState?.enabled
      ? window.api.claudeUsage.getSnapshot({
          scope: input.claude.summary?.scope ?? 'orca',
          range
        })
      : null,
    input.codex.scanState?.enabled
      ? window.api.codexUsage.getSnapshot({
          scope: input.codex.summary?.scope ?? 'orca',
          range
        })
      : null,
    input.opencode.scanState?.enabled
      ? window.api.openCodeUsage.getSnapshot({
          scope: input.opencode.summary?.scope ?? 'orca',
          range
        })
      : null,
    input.muse.scanState?.enabled
      ? window.api.museUsage.getSnapshot({
          scope: input.muse.summary?.scope ?? 'orca',
          range
        })
      : null
  ])
  return {
    claude: claude ?? input.claude,
    codex: codex ?? input.codex,
    opencode: opencode ?? input.opencode,
    muse: muse ?? input.muse
  }
}

type RangeResult = {
  source: UsageOverviewInput
  range: UsageRange
  day: string
} & ({ input: UsageOverviewInput; error: null } | { input: null; error: string })

/** Loads a range for the supplied local day and hides stale results after selection or source changes. */
export function useUsageOverviewRange(
  source: UsageOverviewInput,
  range: UsageRange,
  day: string
): { input: UsageOverviewInput; loading: boolean; error: string | null } {
  const [result, setResult] = useState<RangeResult | null>(null)
  const enabled = Object.values(source).some((provider) => provider.scanState?.enabled)

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void queryUsageOverviewRange(source, range).then(
      (input) => {
        if (!cancelled) {
          setResult({ source, range, day, input, error: null })
        }
      },
      (error: unknown) => {
        if (!cancelled) {
          setResult({
            source,
            range,
            day,
            input: null,
            error: error instanceof Error ? error.message : 'Unable to load usage'
          })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [source, range, day, enabled])

  const current = result?.source === source && result.range === range && result.day === day
  return {
    input: current && result.input ? result.input : source,
    loading: enabled && !current,
    error: current ? result.error : null
  }
}
