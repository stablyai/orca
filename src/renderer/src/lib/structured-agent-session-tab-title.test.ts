// A structured chat is named by the same AI Vault pipeline that names a terminal-backed session:
// the host publishes the provider conversation id, the scanner resolves a title from the provider's
// own transcript, and the unified chat row is where that title lands.

import { describe, expect, it } from 'vitest'
import type { AiVaultSessionTitle } from '../../../shared/ai-vault-session-title'
import type { Tab } from '../../../shared/tab-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { resolveUnifiedTabLabel } from '../../../shared/tab-title-resolution'
import type { AppState } from '@/store/types'
import { applyAgentSessionAiVaultTitle } from '@/store/slices/agent-session-tab-ai-vault-title'
import { collectAiVaultTitleRequests } from './ai-vault-tab-title-requests'

const WORKTREE = 'wt-chat'
const PROVIDER_SESSION = 'provider-session-1'

function chatTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 'agent-session:session-1',
    entityId: 'session-1',
    groupId: 'group-1',
    worktreeId: WORKTREE,
    executionHostId: 'local',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    agentSessionProviderSessionId: PROVIDER_SESSION,
    label: 'Claude Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    ...overrides
  } as Tab
}

function terminalTab(): TerminalTab {
  return {
    id: 'tab-terminal',
    worktreeId: WORKTREE,
    ptyId: null,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 1,
    createdAt: 1
  } as TerminalTab
}

function stateWith(input: { chatTabs?: Tab[]; terminalTabs?: TerminalTab[] }): AppState {
  const terminalTabs = input.terminalTabs ?? []
  const paneKey = `${terminalTabs[0]?.id ?? 'tab-terminal'}:00000000-0000-4000-8000-000000000001`
  return {
    agentStatusByPaneKey:
      terminalTabs.length > 0
        ? {
            [paneKey]: {
              paneKey,
              tabId: terminalTabs[0]!.id,
              worktreeId: WORKTREE,
              agentType: 'codex' as const,
              providerSession: { key: 'session_id' as const, id: 'terminal-session-1' },
              state: 'done' as const,
              prompt: '',
              updatedAt: 1,
              stateStartedAt: 1,
              stateHistory: []
            }
          }
        : {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: { [WORKTREE]: terminalTabs },
    unifiedTabsByWorktree: { [WORKTREE]: input.chatTabs ?? [] },
    terminalLayoutsByTabId: {},
    activeWorktreeId: WORKTREE,
    activeWorkspaceExecutionHostId: 'local',
    worktreesByRepo: { fixture: [{ id: WORKTREE, repoId: 'fixture', hostId: 'local' }] },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    repos: [],
    settings: {}
  } as unknown as AppState
}

const RESOLVED: AiVaultSessionTitle = {
  agent: 'claude',
  sessionId: PROVIDER_SESSION,
  title: 'Fix the flaky probe'
}

describe('structured chat tabs in the AI Vault title pipeline', () => {
  it('requests a title for a chat whose provider conversation is proven, and none before that', () => {
    const proven = collectAiVaultTitleRequests(stateWith({ chatTabs: [chatTab()] }))
    expect(proven).toHaveLength(1)
    expect(proven[0]).toMatchObject({
      agent: 'claude',
      executionHostId: 'local',
      providerSession: { key: 'session_id', id: PROVIDER_SESSION },
      refresh: true,
      tabId: 'agent-session:session-1',
      worktreeId: WORKTREE
    })

    const unproven = collectAiVaultTitleRequests(
      stateWith({ chatTabs: [chatTab({ agentSessionProviderSessionId: undefined })] })
    )
    expect(unproven).toHaveLength(0)
  })

  it('produces no request for an agent outside the Claude/Codex gate', () => {
    const requests = collectAiVaultTitleRequests(
      stateWith({
        chatTabs: [chatTab({ agentSessionAgent: 'gemini' as Tab['agentSessionAgent'] })]
      })
    )
    expect(requests).toHaveLength(0)
  })

  it('writes a resolved title onto the chat row and shows it as the tab label', () => {
    const before = { [WORKTREE]: [chatTab()] }
    const after = applyAgentSessionAiVaultTitle(before, 'agent-session:session-1', RESOLVED)
    expect(after).not.toBeNull()
    const named = after![WORKTREE]![0]!
    expect(named.aiVaultTitle).toEqual(RESOLVED)
    expect(resolveUnifiedTabLabel(named, false, named.label)).toBe('Fix the flaky probe')
  })

  it('reports no change when the resolved title is the one already stored', () => {
    const stored = { [WORKTREE]: [chatTab({ aiVaultTitle: RESOLVED })] }
    expect(applyAgentSessionAiVaultTitle(stored, 'agent-session:session-1', RESOLVED)).toBeNull()
  })

  it('keeps a manual rename above the provider title, and reveals it again when cleared', () => {
    const renamed = chatTab({ aiVaultTitle: RESOLVED, customLabel: 'My rename' })
    expect(resolveUnifiedTabLabel(renamed, false, renamed.label)).toBe('My rename')

    const cleared = { ...renamed, customLabel: null }
    expect(resolveUnifiedTabLabel(cleared, false, cleared.label)).toBe('Fix the flaky probe')
  })

  it('leaves terminal-backed requests exactly as they were', () => {
    const terminalOnly = collectAiVaultTitleRequests(stateWith({ terminalTabs: [terminalTab()] }))
    expect(terminalOnly).toHaveLength(1)
    expect(terminalOnly[0]).toMatchObject({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'terminal-session-1' },
      tabId: 'tab-terminal'
    })

    // A chat alongside it adds one request and changes nothing about the terminal's.
    const both = collectAiVaultTitleRequests(
      stateWith({ terminalTabs: [terminalTab()], chatTabs: [chatTab()] })
    )
    expect(both).toHaveLength(2)
    expect(both.find((request) => request.tabId === 'tab-terminal')).toEqual(terminalOnly[0])
  })

  it('does not write a chat title onto a terminal tab that owns the same id', () => {
    const unrelated = { [WORKTREE]: [chatTab({ contentType: 'terminal' })] }
    expect(applyAgentSessionAiVaultTitle(unrelated, 'agent-session:session-1', RESOLVED)).toBeNull()
  })
})
