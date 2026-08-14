import { summarizeProviderChecks } from '../../../shared/provider-check-summary'
import type { PRCheckDetail } from '../../../shared/github/check-types'
import type { ProviderCheckSummary } from '../../../shared/github/pull-request-types'

export function deriveTaskPagePRCheckSummary(checks: PRCheckDetail[]): ProviderCheckSummary {
  return summarizeProviderChecks(checks)
}
