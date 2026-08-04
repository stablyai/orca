import { summarizeProviderChecks } from '../../../shared/provider-check-summary'
import type { PRCheckDetail, ProviderCheckSummary } from '../../../shared/types'

export function deriveTaskPagePRCheckSummary(checks: PRCheckDetail[]): ProviderCheckSummary {
  return summarizeProviderChecks(checks)
}
