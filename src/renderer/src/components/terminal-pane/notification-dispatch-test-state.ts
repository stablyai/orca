import type { vi } from 'vitest'
import type { WorkOrigin } from '../../../../shared/work-origin'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

export type MockState = {
  runtimeEnvironments: { id: string; pairedDeviceId: string }[]
  activeWorktreeId: string | null
  activeTabId: string | null
  tabsByWorktree: Record<
    string,
    {
      id: string
      ptyId?: string | null
      workOrigin?: WorkOrigin
      workOriginsByLeafId?: Record<string, WorkOrigin>
    }[]
  >
  ptyIdsByTabId: Record<string, string[]>
  suppressedPtyExitIds: Record<string, boolean>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  browserTabsByWorktree: Record<string, unknown[]>
  retainedAgentsByPaneKey: Record<string, { worktreeId: string }>
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  worktreesByRepo: Record<
    string,
    {
      id: string
      repoId: string
      displayName?: string
      branch?: string
      workspaceStatus?: string
    }[]
  >
  repos: { id: string; displayName?: string; connectionId?: string | null }[]
  settings: {
    experimentalTerminalAttention?: boolean
    notifications?: {
      enabled?: boolean
      customSoundPath?: string | null
      customSoundId?: string | null
    }
  }
  markWorktreeUnread: ReturnType<typeof vi.fn>
  markTerminalTabUnread: ReturnType<typeof vi.fn>
  markTerminalPaneUnread: ReturnType<typeof vi.fn>
  markAgentCompletionPaneUnread: ReturnType<typeof vi.fn>
}

export function makeAgentStatus(
  paneKey: string,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  const now = Date.now()
  return {
    state: 'done',
    prompt: 'codex-hook-notify',
    updatedAt: now,
    stateStartedAt: now,
    agentType: 'codex',
    paneKey,
    terminalTitle: 'codex',
    stateHistory: [],
    lastAssistantMessage: 'Done.',
    ...overrides
  }
}
