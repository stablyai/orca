import { summarizeProviderChecks } from '../../../../shared/source-control/checks/provider-check-summary'
import type { PRCheckDetail } from '../../../../shared/github/checks/check-types'
import type { ProviderCheckSummary } from '../../../../shared/github/pull-requests/pull-request-types'

export function deriveTaskPagePRCheckSummary(checks: PRCheckDetail[]): ProviderCheckSummary {
  const summary = summarizeProviderChecks(checks)
  // Detail lists do not prove completeness; only whole-PR reads publish cancellation metadata.
  delete summary.cancelled
  return summary
}
