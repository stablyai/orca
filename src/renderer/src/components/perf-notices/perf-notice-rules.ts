import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { PerfNoticeSignals } from '../../../../shared/diagnostics/perf-notice-signals'
import { formatAgentTypeLabel } from '../../../../shared/agent-status/presentation/agent-type-label'
import {
  getRepoExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import { nativeChatIdleStopMinutes } from '../../../../shared/native-chat/settings/native-chat-idle-stop'
import type { AppState } from '../../store/types'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '../../store/workspaces/catalog/workspace-record-fields'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspaces/folder-workspace-worktree'

const GB = 1024 ** 3
export const IDLE_AGENT_MS = 2 * 60 * 60_000
const IDLE_AGENT_MIN = 4
const HIDDEN_TAB_MIN = 10
export const LOW_MEMORY_FRACTION = 0.15
export const TIGHT_MEMORY_FRACTION = 0.25

/** Flip when Agent Sleep leaves Experimental; the copy already fits. */
export const PERF_NOTICE_OFFERS_AGENT_SLEEP = false

export type IdleAgents = { terminal: number; chats: number; terminalLabels: string[] }

export function availableFraction(signals: PerfNoticeSignals): number | null {
  const memory = signals.memory
  return memory && memory.totalMemory > 0 ? memory.availableMemory / memory.totalMemory : null
}

export function isDiskAlmostFull(signals: PerfNoticeSignals): boolean {
  const disk = signals.disk
  return (
    !!disk &&
    disk.totalBytes > 0 &&
    (disk.freeBytes < 10 * GB || disk.freeBytes / disk.totalBytes < 0.05)
  )
}

/** Agents on this machine whose turn ended at least idleMs ago and still hold a live process. */
export function countIdleAgents(state: AppState, now: number, idleMs = IDLE_AGENT_MS): IdleAgents {
  const chatsNeverStop = nativeChatIdleStopMinutes(state.settings) === 0
  const idle: AgentStatusEntry[] = []
  for (const entry of state.agentStatusByPaneKey.values()) {
    if (entry.state === 'done' && !entry.paneSleep && now - entry.stateStartedAt >= idleMs) {
      idle.push(entry)
    }
  }
  if (idle.length === 0) {
    return { terminal: 0, chats: 0, terminalLabels: [] }
  }
  const localTabIds = collectLocalTabIds(state)
  const labels = new Set<string>()
  let terminal = 0
  let chats = 0
  for (const entry of idle) {
    if (entry.structuredHostOwned) {
      // Why: with auto-stop on, an idle chat's agent has already been stopped.
      chats += chatsNeverStop ? 1 : 0
      continue
    }
    if (!localTabIds.has(entry.paneKey.split(':')[0] ?? '')) {
      continue
    }
    terminal += 1
    labels.add(formatAgentTypeLabel(entry.agentType))
  }
  return { terminal, chats, terminalLabels: [...labels] }
}

function collectLocalTabIds(state: AppState): Set<string> {
  const localWorktreeIds: string[] = []
  for (const repo of state.repos) {
    if (parseExecutionHostId(getRepoExecutionHostId(repo))?.kind === 'local') {
      for (const worktree of selectWorktreesByRepo(state)[repo.id] ?? []) {
        localWorktreeIds.push(worktree.id)
      }
    }
  }
  for (const folder of selectFolderWorkspaces(state)) {
    const worktree = folderWorkspaceToWorktree(folder)
    if (parseExecutionHostId(worktree.hostId)?.kind === 'local') {
      localWorktreeIds.push(worktree.id)
    }
  }
  const tabIds = new Set<string>()
  for (const worktreeId of localWorktreeIds) {
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      tabIds.add(tab.id)
    }
  }
  return tabIds
}

export function isIdleAgentsDue(idle: IdleAgents, signals: PerfNoticeSignals): boolean {
  const fraction = availableFraction(signals)
  return (
    fraction !== null &&
    fraction < TIGHT_MEMORY_FRACTION &&
    idle.terminal + idle.chats >= IDLE_AGENT_MIN
  )
}

export function isHiddenBrowserTabsDue(state: AppState, signals: PerfNoticeSignals): boolean {
  const fraction = availableFraction(signals)
  return (
    state.settings?.browserGuestWorktreeRetentionBudget === false &&
    signals.hiddenBrowserPages >= HIDDEN_TAB_MIN &&
    fraction !== null &&
    fraction < TIGHT_MEMORY_FRACTION
  )
}
