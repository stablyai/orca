import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { PerfNoticeSignals } from '../../../../shared/diagnostics/perf-notice-signals'
import type { MemorySnapshot } from '../../../../shared/diagnostics/process-stats-types'
import { getPtyExecutionHost } from '../../../../shared/terminal/pty/lifecycle/terminal-execution-host'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import { isProgramStatusRow } from '../../../../shared/program-status/program-status-row'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { nativeChatIdleStopMinutes } from '../../../../shared/native-chat/settings/native-chat-idle-stop'
import { getFolderWorkspaceWorktreeHostId } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { AppState } from '../../store/types'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../../store/workspaces/catalog/workspace-record-fields'

const GB = 1024 ** 3
export const IDLE_AGENT_MS = 2 * 60 * 60_000
export const IDLE_AGENT_MIN = 4
export const HIDDEN_TAB_MIN = 10
export const LOW_MEMORY_FRACTION = 0.15
export const TIGHT_MEMORY_FRACTION = 0.25
/** Terminals must hold most of the used memory before a notice says they do. */
export const TERMINAL_SHARE_MIN = 0.5

/** Flip when Agent Sleep leaves Experimental; the copy already fits. */
export const PERF_NOTICE_OFFERS_AGENT_SLEEP = false

export type IdleAgents = { terminal: number; chats: number; terminalLabels: string[] }

export function availableFraction(signals: PerfNoticeSignals): number | null {
  const memory = signals.memory
  return memory && memory.totalMemory > 0 ? memory.availableMemory / memory.totalMemory : null
}

/** Under 10 GB, or under 5% on small disks: a large disk with plenty left is never "almost full". */
export function isDiskAlmostFull(signals: PerfNoticeSignals): boolean {
  const disk = signals.disk
  return !!disk && disk.totalBytes > 0 && disk.freeBytes < Math.min(10 * GB, disk.totalBytes * 0.05)
}

/** Turns that ended at least idleMs ago and are not asleep; cheap, so callers can bail before proving liveness. */
export function idleAgentCandidates(
  state: Pick<AppState, 'agentStatusByPaneKey'>,
  now: number,
  idleMs = IDLE_AGENT_MS
): AgentStatusEntry[] {
  const candidates: AgentStatusEntry[] = []
  for (const entry of state.agentStatusByPaneKey.values()) {
    // Why: a finished program's kept result row is not an agent holding memory.
    if (
      entry.state === 'done' &&
      !entry.paneSleep &&
      !isProgramStatusRow(entry) &&
      now - entry.stateStartedAt >= idleMs
    ) {
      candidates.push(entry)
    }
  }
  return candidates
}

/** PTYs with a running process on this machine, from one memory snapshot. */
export type LiveLocalTerminals = { sessionIds: ReadonlySet<string>; paneKeys: ReadonlySet<string> }

export const NO_LIVE_TERMINALS: LiveLocalTerminals = { sessionIds: new Set(), paneKeys: new Set() }

export function liveLocalTerminals(snapshot: MemorySnapshot): LiveLocalTerminals {
  const sessionIds = new Set<string>()
  const paneKeys = new Set<string>()
  for (const worktree of snapshot.worktrees) {
    for (const session of worktree.sessions) {
      sessionIds.add(session.sessionId)
      if (session.paneKey) {
        paneKeys.add(session.paneKey)
      }
    }
  }
  return { sessionIds, paneKeys }
}

/** Store-only split: chats that count, and local terminal rows that still need a snapshot to prove they're alive. */
export type LocalIdleCandidates = { chats: number; terminals: AgentStatusEntry[] }

/** A chat counts while the host runs its agent, its workspace is local, and auto-stop is off. */
export function localIdleCandidates(
  state: AppState,
  candidates: readonly AgentStatusEntry[]
): LocalIdleCandidates {
  const chatsNeverStop = nativeChatIdleStopMinutes(state.settings) === 0
  const possible = candidates.filter((entry) =>
    entry.structuredHostOwned ? chatsNeverStop : entry.connectionId == null
  )
  // Why: one catalog walk per check, never one per agent.
  const localWorktrees = possible.length > 0 ? collectLocalWorktreeIds(state) : null
  let chats = 0
  const terminals: AgentStatusEntry[] = []
  for (const entry of possible) {
    if (!localWorktrees || !entry.worktreeId || !localWorktrees.has(entry.worktreeId)) {
      continue
    }
    if (entry.structuredHostOwned) {
      chats += 1
    } else {
      terminals.push(entry)
    }
  }
  return { chats, terminals }
}

/** A restored pane keeps its PTY id and finished row after its process is gone, so liveness comes from the snapshot. */
function hasLiveLocalPty(
  state: AppState,
  entry: AgentStatusEntry,
  live: LiveLocalTerminals
): boolean {
  if (live.paneKeys.has(entry.paneKey)) {
    return true
  }
  const pane = parsePaneKey(entry.paneKey)
  const ptyId = pane && state.terminalLayoutsByTabId[pane.tabId]?.ptyIdsByLeafId?.[pane.leafId]
  return !!ptyId && getPtyExecutionHost(ptyId) === null && live.sessionIds.has(ptyId)
}

/** Agents still holding memory on this machine: local chats, and local terminal agents whose PTY is alive. */
export function countIdleAgents(
  state: AppState,
  local: LocalIdleCandidates,
  live: LiveLocalTerminals
): IdleAgents {
  const labels = new Set<string>()
  let terminal = 0
  for (const entry of local.terminals) {
    if (hasLiveLocalPty(state, entry, live)) {
      terminal += 1
      labels.add(formatAgentTypeLabel(entry.agentType))
    }
  }
  return { terminal, chats: local.chats, terminalLabels: [...labels] }
}

function collectLocalWorktreeIds(state: AppState): Set<string> {
  const ids = new Set<string>()
  for (const folder of selectFolderWorkspaces(state)) {
    if (parseExecutionHostId(getFolderWorkspaceWorktreeHostId(folder))?.kind === 'local') {
      ids.add(folderWorkspaceKey(folder.id))
    }
  }
  const worktreesByRepo = selectWorktreesByRepo(state)
  for (const repo of state.repos) {
    const repoHost = getRepoExecutionHostId(repo)
    for (const worktree of worktreesByRepo[repo.id] ?? []) {
      if (parseExecutionHostId(worktree.hostId ?? repoHost)?.kind === 'local') {
        ids.add(worktree.id)
      }
    }
  }
  return ids
}
