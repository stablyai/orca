import { useEffect, useMemo } from 'react'
import { useAppStore } from '../../store'
import { buildUsageOverview } from './usage-overview-model'
import type { UsageOverviewModel } from './usage-overview-types'

/** Loads every usage provider's ledger without changing its range or enabled state. */
export function useUsageOverview(): UsageOverviewModel {
  const claudeScanState = useAppStore((state) => state.claudeUsageScanState)
  const claudeSummary = useAppStore((state) => state.claudeUsageSummary)
  const claudeDaily = useAppStore((state) => state.claudeUsageDaily)
  const codexScanState = useAppStore((state) => state.codexUsageScanState)
  const codexSummary = useAppStore((state) => state.codexUsageSummary)
  const codexDaily = useAppStore((state) => state.codexUsageDaily)
  const openCodeScanState = useAppStore((state) => state.openCodeUsageScanState)
  const openCodeSummary = useAppStore((state) => state.openCodeUsageSummary)
  const openCodeDaily = useAppStore((state) => state.openCodeUsageDaily)
  const museScanState = useAppStore((state) => state.museUsageScanState)
  const museSummary = useAppStore((state) => state.museUsageSummary)
  const museDaily = useAppStore((state) => state.museUsageDaily)
  const fetchClaudeUsage = useAppStore((state) => state.fetchClaudeUsage)
  const fetchCodexUsage = useAppStore((state) => state.fetchCodexUsage)
  const fetchOpenCodeUsage = useAppStore((state) => state.fetchOpenCodeUsage)
  const fetchMuseUsage = useAppStore((state) => state.fetchMuseUsage)

  useEffect(() => {
    void fetchClaudeUsage()
    void fetchCodexUsage()
    void fetchOpenCodeUsage()
    void fetchMuseUsage()
  }, [fetchClaudeUsage, fetchCodexUsage, fetchOpenCodeUsage, fetchMuseUsage])

  const overview = useMemo(
    () =>
      buildUsageOverview({
        claude: {
          scanState: claudeScanState,
          summary: claudeSummary,
          daily: claudeDaily
        },
        codex: {
          scanState: codexScanState,
          summary: codexSummary,
          daily: codexDaily
        },
        opencode: {
          scanState: openCodeScanState,
          summary: openCodeSummary,
          daily: openCodeDaily
        },
        muse: {
          scanState: museScanState,
          summary: museSummary,
          daily: museDaily
        }
      }),
    [
      claudeDaily,
      claudeScanState,
      claudeSummary,
      codexDaily,
      codexScanState,
      codexSummary,
      museDaily,
      museScanState,
      museSummary,
      openCodeDaily,
      openCodeScanState,
      openCodeSummary
    ]
  )

  return overview
}
