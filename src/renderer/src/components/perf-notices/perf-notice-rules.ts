import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { PerfNoticeSignals } from '../../../../shared/diagnostics/perf-notice-signals'
import type { PtyListedSession } from '../../../../shared/terminal/pty/lifecycle/pty-listed-session'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { nativeChatIdleStopMinutes } from '../../../../shared/native-chat/settings/native-chat-idle-stop'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'
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
    if (entry.state === 'done' && !entry.paneSleep && now - entry.stateStartedAt >= idleMs) {
      candidates.push(entry)
    }
  }
  return candidates
}

/**
 * Agents still holding memory on this machine. A terminal agent counts only while the local daemon
 * still reports an agent in its pane (a finished row can outlive the agent); a chat counts only while
 * the host runs its agent, its workspace is local, and auto-stop is off.
 */
export function countIdleAgents(
  state: AppState,
  candidates: readonly AgentStatusEntry[],
  localSessions: readonly Pick<PtyListedSession, 'paneKey' | 'agentOwnership' | 'exiting'>[]
): IdleAgents {
  const liveAgentPanes = new Set<string>()
  for (const session of localSessions) {
    if (session.paneKey && session.agentOwnership === 'present' && !session.exiting) {
      liveAgentPanes.add(session.paneKey)
    }
  }
  const chatsNeverStop = nativeChatIdleStopMinutes(state.settings) === 0
  const chatCandidates = chatsNeverStop
    ? candidates.filter((entry) => entry.structuredHostOwned && entry.worktreeId)
    : []
  // Why: one catalog walk per check, never one per chat.
  const localWorktrees = chatCandidates.length > 0 ? collectLocalWorktreeIds(state) : null
  const labels = new Set<string>()
  let terminal = 0
  let chats = 0
  for (const entry of candidates) {
    if (entry.structuredHostOwned) {
      if (localWorktrees && entry.worktreeId && localWorktrees.has(entry.worktreeId)) {
        chats += 1
      }
    } else if (liveAgentPanes.has(entry.paneKey)) {
      terminal += 1
      labels.add(formatAgentTypeLabel(entry.agentType))
    }
  }
  return { terminal, chats, terminalLabels: [...labels] }
}

function collectLocalWorktreeIds(state: AppState): Set<string> {
  const ids = new Set<string>()
  for (const folder of selectFolderWorkspaces(state)) {
    if (parseExecutionHostId(folderWorkspaceToWorktree(folder).hostId)?.kind === 'local') {
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
