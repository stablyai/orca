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
    // Why: the status slice bumps the epoch for state/freshness changes;
    // same-epoch map writes are fresh same-state metadata and cannot alter decay.
    if (cachedGlobalEpoch === state.agentStatusEpoch) {
      return cachedSignature
    }
    cachedGlobalEpoch = state.agentStatusEpoch
    // Why: the global epoch wakes every card, but only cards whose effective
    // fresh/stale row state changed should render and rebuild their row trees.
    cachedSignature = buildWorktreeAgentFreshnessSignature(state, worktreeId, readNow())
    return cachedSignature
  }
}
