import type { AiVaultSessionTitlesResult } from '../../../../../../shared/ai-vault/contracts/ai-vault-session-title'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

function terminalTab(worktreeId: string, aiVaultTitle?: TerminalTab['aiVaultTitle']): TerminalTab {
  return {
    id: 'tab-1',
    ptyId: null,
    worktreeId,
    title: '⠋ albacore',
    aiVaultTitle,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

export function titleResult(agent: 'claude' | 'codex', title: string): AiVaultSessionTitlesResult {
  return { titles: [{ agent, sessionId: `${agent}-session`, title }] }
}

export function makeState(args: {
  agent?: 'claude' | 'codex'
  aiVaultTitle?: TerminalTab['aiVaultTitle']
  executionHostId: 'local' | 'ssh:dev-box' | 'runtime:server-1'
  sleeping?: boolean
  path: string
  worktreeId: string
}) {
  const agent = args.agent ?? 'codex'
  const tab = terminalTab(args.worktreeId, args.aiVaultTitle)
  const listeners = new Set<(state: AppState, previous: AppState) => void>()
  const providerSession = {
    key: 'session_id' as const,
    id: `${agent}-session`,
    transcriptPath: `/sessions/${agent}.jsonl`
  }
  const statusEntry = {
    state: 'done' as const,
    prompt: '',
    updatedAt: 1,
    stateStartedAt: 1,
    agentType: agent,
    paneKey: 'tab-1:00000000-0000-4000-8000-000000000001',
    tabId: 'tab-1',
    worktreeId: args.worktreeId,
    providerSession,
    stateHistory: []
  }
  let state: AppState = {
    ...useAppStore.getInitialState(),
    activeWorktreeId: args.worktreeId,
    activeWorkspaceExecutionHostId: args.executionHostId,
    agentStatusByPaneKey: args.sleeping
      ? {}
      : { 'tab-1:00000000-0000-4000-8000-000000000001': statusEntry },
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: args.sleeping
      ? {
          'tab-1:00000000-0000-4000-8000-000000000001': {
            paneKey: 'tab-1:00000000-0000-4000-8000-000000000001',
            tabId: 'tab-1',
            worktreeId: args.worktreeId,
            agent,
            providerSession,
            prompt: '',
            state: 'done',
            capturedAt: 1,
            updatedAt: 1,
            origin: 'worktree-sleep'
          }
        }
      : {},
    tabsByWorktree: { [args.worktreeId]: [tab] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: '00000000-0000-4000-8000-000000000001' },
        activeLeafId: '00000000-0000-4000-8000-000000000001',
        expandedLeafId: null
      }
    },
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    getKnownWorktreeById: () =>
      makeWorktree({ id: args.worktreeId, repoId: 'repo-1', path: args.path }),
    setAiVaultTabTitle: (tabId: string, aiVaultTitle: TerminalTab['aiVaultTitle'] | null) => {
      const previous = state
      state = {
        ...state,
        tabsByWorktree: {
          [args.worktreeId]: state.tabsByWorktree[args.worktreeId].map((entry: TerminalTab) =>
            entry.id === tabId ? { ...entry, aiVaultTitle } : entry
          )
        }
      }
      for (const listener of listeners) {
        listener(state, previous)
      }
    }
  }
  return {
    getState: () => state,
    update: (patch: Partial<AppState>) => {
      const previous = state
      state = { ...state, ...patch }
      for (const listener of listeners) {
        listener(state, previous)
      }
    },
    pingAgentStatus: () => {
      const previous = state
      state = {
        ...state,
        agentStatusByPaneKey: Object.fromEntries(
          Object.entries(state.agentStatusByPaneKey).map(([paneKey, entry]) => [
            paneKey,
            { ...entry, updatedAt: entry.updatedAt + 1 }
          ])
        )
      }
      for (const listener of listeners) {
        listener(state, previous)
      }
    },
    setProviderSessionId: (sessionId: string) => {
      const previous = state
      state = {
        ...state,
        agentStatusByPaneKey: Object.fromEntries(
          Object.entries(state.agentStatusByPaneKey).map(([paneKey, entry]) => {
            if (!entry.providerSession) {
              return [paneKey, entry]
            }
            return [
              paneKey,
              { ...entry, providerSession: { ...entry.providerSession, id: sessionId } }
            ]
          })
        )
      }
      for (const listener of listeners) {
        listener(state, previous)
      }
    },
    setWorkspacePath: (path: string) => {
      args.path = path
      const previous = state
      state = { ...state, worktreesByRepo: { changed: [] } }
      for (const listener of listeners) {
        listener(state, previous)
      }
    },
    nameFromHost: (title: string) => {
      const previous = state
      state = {
        ...state,
        tabsByWorktree: {
          [args.worktreeId]: state.tabsByWorktree[args.worktreeId].map((entry: TerminalTab) => ({
            ...entry,
            aiVaultTitle: { agent, sessionId: providerSession.id, title },
            sessionTitleFromHost: true as const
          }))
        }
      }
      for (const listener of listeners) {
        listener(state, previous)
      }
    },
    removeSleepingRecord: () => {
      const previous = state
      state = { ...state, sleepingAgentSessionsByPaneKey: {} }
      for (const listener of listeners) {
        listener(state, previous)
      }
    },
    subscribe: (listener: (next: AppState, previous: AppState) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }
}
