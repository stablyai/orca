import type { AppState } from '../../types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import { IDLE, type WorktreeAttention } from '../../../../../shared/sidebar-list/smart-attention'
import type { AgentStatusProjectionState } from './agent-status-projection-state'

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
  for (const cls of [1, 2, 3, 4] as const) {
    if (b.attention[cls - 1].size) {
      attention = {
        cls,
        attentionTimestamp: -b.attention[cls - 1].next
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
      data.mobileOutputs.set(
        owner,
        new Map(
          [...keys].flatMap((key) => {
            const row = statuses.get(key)
            return row ? [[key, row] as const] : []
          })
        )
      )
    }
  }
  return data.mobileOutputs
}
