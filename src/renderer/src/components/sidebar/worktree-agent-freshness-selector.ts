import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import type { AppState } from '@/store/types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import { selectLiveAgentStatusEntriesForWorktree } from './worktree-agent-row-selectors'

export const EMPTY_WORKTREE_AGENT_FRESHNESS_SIGNATURE = ''

type WorktreeAgentFreshnessState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'agentStatusEpoch'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'tabsByWorktree'
>

function buildWorktreeAgentFreshnessSignature(
  state: WorktreeAgentFreshnessState,
  worktreeId: string,
  now: number
): string {
  let signature = ''
  for (const entry of selectLiveAgentStatusEntriesForWorktree(state, worktreeId)) {
    if (entry.state !== 'working' && entry.state !== 'blocked' && entry.state !== 'waiting') {
      continue
    }
    signature += `${entry.paneKey}\0${
      isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS) ? '1' : '0'
    }\0`
  }
  return signature
}

export function createWorktreeAgentFreshnessSelector(
  worktreeId: string,
  readNow: () => number = Date.now
): (state: WorktreeAgentFreshnessState) => string {
  let cachedGlobalEpoch: number | null = null
  let cachedSignature = EMPTY_WORKTREE_AGENT_FRESHNESS_SIGNATURE

  return (state) => {
    // Same-epoch writes change metadata only; state/freshness changes bump the epoch.
    if (cachedGlobalEpoch === state.agentStatusEpoch) {
      return cachedSignature
    }
    cachedGlobalEpoch = state.agentStatusEpoch
    // Only cards whose effective fresh/stale state changed need a new signature.
    cachedSignature = buildWorktreeAgentFreshnessSignature(state, worktreeId, readNow())
    return cachedSignature
  }
}
