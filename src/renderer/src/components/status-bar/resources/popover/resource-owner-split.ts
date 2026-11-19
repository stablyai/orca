import type { MemorySnapshot } from '../../../../../../shared/diagnostics/process-stats-types'
import type { PtyListedSession } from '../../../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import { useAppStore } from '../../../../store/index'

export type ResourceOwnerUsage = { cpu: number; memory: number }

/** This machine's memory by who started it, so no single total reads as Orca's own usage. */
export type ResourceOwnerSplit = {
  orca: ResourceOwnerUsage
  agents: ResourceOwnerUsage
  yourProcesses: ResourceOwnerUsage
  otherApps: number
  available: number
  hostTotal: number
}

type DaemonSessionFacts = Pick<PtyListedSession, 'id' | 'paneKey' | 'agentOwnership'>

/** The snapshot is this machine only, so SSH and paired-server sessions never enter the split. */
export function splitSnapshotByOwner(
  snapshot: MemorySnapshot,
  daemonSessions: readonly DaemonSessionFacts[],
  agentPaneKeys: { has(paneKey: string): boolean }
): ResourceOwnerSplit {
  const daemonById = new Map(daemonSessions.map((session) => [session.id, session]))
  const agents = { cpu: 0, memory: 0 }
  const yourProcesses = { cpu: 0, memory: 0 }
  for (const worktree of snapshot.worktrees) {
    for (const session of worktree.sessions) {
      const daemon = daemonById.get(session.sessionId)
      // Why: boot-hydrated samples carry no pane key; the daemon's binding still does.
      const paneKey = session.paneKey ?? daemon?.paneKey ?? null
      const isAgent =
        daemon?.agentOwnership === 'present' || (paneKey !== null && agentPaneKeys.has(paneKey))
      const bucket = isAgent ? agents : yourProcesses
      bucket.cpu += session.cpu
      bucket.memory += session.memory
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
    available: Math.max(0, availableMemory),
    hostTotal
  }
}

export function readAgentPaneKeys(): { has(paneKey: string): boolean } {
  return useAppStore.getState().agentStatusByPaneKey
}
