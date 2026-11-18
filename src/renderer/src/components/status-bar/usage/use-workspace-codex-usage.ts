import type { RateLimitState } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { useWorkspaceAccountUsage } from './use-workspace-account-usage'
export function useWorkspaceCodexUsage(
  state: RateLimitState,
  remoteOwned: boolean,
  refreshOwner: (() => Promise<void>) | null
) {
  return useWorkspaceAccountUsage(state, 'codex', remoteOwned, refreshOwner)
}
