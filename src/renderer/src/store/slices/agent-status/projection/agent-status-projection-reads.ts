import type { AppState } from '../../../types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import {
  IDLE,
  type WorktreeAttention
} from '../../../../../../shared/sidebar-list/sorting/smart-attention'
import type { AgentStatusProjectionState } from './agent-status-projection-state'

const ATTENTION_CLASSES = [1, 2, 3, 4] as const

export function readProjectionAttention(
  data: AgentStatusProjectionState,
  worktreeId: string,
  lastActivityAt = 0,
  now = Date.now()
): WorktreeAttention {
  const b = data.worktrees.get(worktreeId)
  if (!b) {
    return IDLE
  }
  let attention = IDLE
  for (let i = 0; i < ATTENTION_CLASSES.length; i += 1) {
    if (b.attention[i].size) {
      attention = {
        cls: ATTENTION_CLASSES[i],
        attentionTimestamp: -b.attention[i].next
      }
      break
    }
  }
  if (b.counts.has('titlePermission')) {
    return {
      cls: 1,
      attentionTimestamp: Math.max(attention.cls === 1 ? attention.attentionTimestamp : 0, now)
    }
  }
  if (b.counts.has('titleWorking') && attention.cls >= 3) {
    return {
      cls: 3,
      attentionTimestamp: Math.max(
        attention.cls === 3 ? attention.attentionTimestamp : 0,
        lastActivityAt
      )
    }
  }
  return attention
}
export function readProjectionMobileSnapshots(
  data: AgentStatusProjectionState,
  statuses: AppState['agentStatusByPaneKey']
): ReadonlyMap<string, ReadonlyMap<string, AgentStatusEntry>> {
  for (const [owner, keys] of data.mobileKeys) {
    if (!data.mobileOutputs.has(owner)) {
      const snapshot = new Map<string, AgentStatusEntry>()
      for (const key of keys) {
        const row = statuses.get(key)
        if (row) {
          snapshot.set(key, row)
        }
      }
      data.mobileOutputs.set(owner, snapshot)
    }
  }
  return data.mobileOutputs
}
