import type { WorktreeStatus } from '../worktree/row-display/worktree-status-rollup'

/** A bot row shows four states: working, needs you, available (green), or paused (grey). */
export type BotRowStatus = Extract<WorktreeStatus, 'working' | 'permission' | 'active' | 'inactive'>

export function foldBotStatus(status: WorktreeStatus, paused: boolean): BotRowStatus {
  if (status === 'permission') {
    return 'permission'
  }
  if (status === 'working' || status === 'monitoring') {
    return 'working'
  }
  return paused ? 'inactive' : 'active'
}
