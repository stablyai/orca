import type { MemorySnapshot } from '../../../../../../shared/diagnostics/process-stats-types'
import { useAppStore } from '../../../../store/index'
import type { UnifiedProjectGroup } from '../workspace-attribution/resource-usage-merge-types'

export type ResourceOwnerUsage = { cpu: number; memory: number }

/** This machine's memory by who started it, so no single total reads as Orca's own usage. */
export type ResourceOwnerSplit = {
  orca: ResourceOwnerUsage
  agents: ResourceOwnerUsage
  yourProcesses: ResourceOwnerUsage
  otherApps: number
  free: number
  hostTotal: number
}

export function splitResourceUsageByOwner(
  snapshot: MemorySnapshot,
  repos: readonly UnifiedProjectGroup[],
  agentPaneKeys: { has(paneKey: string): boolean }
): ResourceOwnerSplit {
  const agents = { cpu: 0, memory: 0 }
  const yourProcesses = { cpu: 0, memory: 0 }
  for (const repo of repos) {
    for (const worktree of repo.worktrees) {
      // Why: SSH and paired-server rows run on another machine, not in this machine's bar.
      if (worktree.isRemote || worktree.hostLabel !== undefined) {
        continue
      }
      for (const session of worktree.sessions) {
        if (session.memory === null) {
          continue
        }
        const isAgent =
          session.agentOwnership === 'present' ||
          (session.paneKey !== null && agentPaneKeys.has(session.paneKey))
        const bucket = isAgent ? agents : yourProcesses
        bucket.cpu += session.cpu ?? 0
        bucket.memory += session.memory
      }
    }
  }
  const orca = { cpu: snapshot.app.cpu, memory: snapshot.app.memory }
  const { totalMemory: hostTotal, usedMemory, availableMemory } = snapshot.host
  const tracked = orca.memory + agents.memory + yourProcesses.memory
  return {
    orca,
    agents,
    yourProcesses,
    otherApps: Math.max(0, usedMemory - tracked),
    free: Math.max(0, availableMemory),
    hostTotal
  }
}

export function readAgentPaneKeys(): { has(paneKey: string): boolean } {
  return useAppStore.getState().agentStatusByPaneKey
}
