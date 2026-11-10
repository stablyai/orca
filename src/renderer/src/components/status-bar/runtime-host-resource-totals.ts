import type { RuntimeHostResourceSample } from './resource-usage-merge-types'

export type RuntimeHostResourceTotals = {
  cpu: number
  memory: number
  sessionCount: number
}

export function sumRuntimeHostResources(
  hosts: readonly RuntimeHostResourceSample[]
): RuntimeHostResourceTotals {
  const totals: RuntimeHostResourceTotals = { cpu: 0, memory: 0, sessionCount: 0 }
  for (const host of hosts) {
    for (const worktree of host.worktrees) {
      totals.cpu += worktree.cpu
      totals.memory += worktree.memory
      totals.sessionCount += worktree.sessions.length
    }
  }
  return totals
}
