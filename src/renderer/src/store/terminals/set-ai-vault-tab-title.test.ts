// `setAiVaultTabTitle` serves two tab models. A terminal-backed session's name belongs on its
// TerminalTab (and the unified row mirroring it); a structured chat has no TerminalTab, so its
// unified row is the only place the name can live.

import { beforeEach, describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '@/store'

const WORKTREE = 'wt-1'
const TERMINAL_TITLE = { agent: 'codex' as const, sessionId: 'terminal-1', title: 'Terminal name' }
const CHAT_TITLE = { agent: 'claude' as const, sessionId: 'provider-1', title: 'Chat name' }

function terminalTab(): TerminalTab {
  return {
    id: 'tab-terminal',
    worktreeId: WORKTREE,
    ptyId: null,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  } as TerminalTab
}

function unifiedTerminalTab(): Tab {
  return {
    id: 'unified-terminal',
    entityId: 'tab-terminal',
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType: 'terminal',
    label: 'Agent',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  } as Tab
}

function chatTab(): Tab {
  return {
    id: 'agent-session:session-1',
    entityId: 'session-1',
    groupId: 'group-1',
    worktreeId: WORKTREE,
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    agentSessionProviderSessionId: 'provider-1',
    label: 'Claude Chat',
    customLabel: null,
    color: null,
    sortOrder: 1,
    createdAt: 1
  } as Tab
}

function seed(): void {
  useAppStore.setState({
    tabsByWorktree: { [WORKTREE]: [terminalTab()] },
    unifiedTabsByWorktree: { [WORKTREE]: [unifiedTerminalTab(), chatTab()] }
  })
}

function chatRow(): Tab | undefined {
  return useAppStore
    .getState()
    .unifiedTabsByWorktree[WORKTREE]?.find((tab) => tab.contentType === 'agent-session')
}

describe('setAiVaultTabTitle across both tab models', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    seed()
  })

  it('names a terminal tab and the unified row mirroring it', () => {
    useAppStore.getState().setAiVaultTabTitle('tab-terminal', TERMINAL_TITLE)

    const state = useAppStore.getState()
    expect(state.tabsByWorktree[WORKTREE]![0]!.aiVaultTitle).toEqual(TERMINAL_TITLE)
    expect(
      state.unifiedTabsByWorktree[WORKTREE]!.find((tab) => tab.contentType === 'terminal')!
        .aiVaultTitle
    ).toEqual(TERMINAL_TITLE)
    // The chat row is a different session and must not inherit the terminal's name.
    expect(chatRow()?.aiVaultTitle).toBeUndefined()
  })

  it('names a structured chat on its unified row, leaving terminal tabs alone', () => {
    useAppStore.getState().setAiVaultTabTitle('agent-session:session-1', CHAT_TITLE)

    expect(chatRow()?.aiVaultTitle).toEqual(CHAT_TITLE)
    const terminal = useAppStore.getState().tabsByWorktree[WORKTREE]![0]!
    expect(terminal.aiVaultTitle).toBeUndefined()
  })

  it('clears a chat name when the provider no longer reports one', () => {
    useAppStore.getState().setAiVaultTabTitle('agent-session:session-1', CHAT_TITLE)
    useAppStore.getState().setAiVaultTabTitle('agent-session:session-1', null)

    expect(chatRow()?.aiVaultTitle).toBeNull()
  })

  it('leaves state untouched when no tab of either model owns the id', () => {
    const before = useAppStore.getState().unifiedTabsByWorktree
    useAppStore.getState().setAiVaultTabTitle('nobody', CHAT_TITLE)

    expect(useAppStore.getState().unifiedTabsByWorktree).toBe(before)
  })
})
