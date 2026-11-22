import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { workspaceAccountUsage } from './workspace-account-usage'
export function workspaceCodexUsage(state: RateLimitState, accountId: string | undefined) {
  return workspaceAccountUsage(state, 'codex', accountId)
}
