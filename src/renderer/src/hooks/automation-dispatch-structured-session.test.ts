import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockMarkDispatchResult,
  mockCreateWorktree,
  mockLaunchAgentBackgroundSession,
  mockFindReusableAutomationSession,
  mockPlanAgentSessionLaunch,
  mockBeginStructuredProvisionalLaunch,
  mockSendMessageToAgent
} = vi.hoisted(() => ({
  mockMarkDispatchResult: vi.fn(),
  mockCreateWorktree: vi.fn(),
  mockLaunchAgentBackgroundSession: vi.fn(),
  mockFindReusableAutomationSession: vi.fn(),
  mockPlanAgentSessionLaunch: vi.fn(),
  mockBeginStructuredProvisionalLaunch: vi.fn(),
  mockSendMessageToAgent: vi.fn()
}))

let latestStoreSubscriber: (() => void) | null = null
const state: Record<string, unknown> = {
  activeView: 'terminal',
  activeWorktreeId: 'wt-active',
  activeWorkspaceExecutionHostId: null,
  activeTabId: 'tab-active',
  activeTabType: 'terminal',
  settings: { experimentalNativeChat: true },
  repos: [{ id: 'repo-1', connectionId: null, executionHostId: null, path: '/repo' }],
  folderWorkspaces: [],
  projectGroups: [],
  worktreesByRepo: {},
  detectedWorktreesByRepo: {},
  agentStatusByPaneKey: {},
  allWorktrees: vi.fn(() => []),
  getKnownWorktreeById: vi.fn(() => undefined),
  createWorktree: mockCreateWorktree,
  setActiveView: vi.fn(),
  setActiveWorktree: vi.fn(),
  setActiveTab: vi.fn(),
  setActiveTabType: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: vi.fn((listener: () => void) => {
      latestStoreSubscriber = listener
      return () => {}
    })
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'create-request-id'
}))

vi.mock('@/components/automations/automation-host-client', () => ({
  listAutomationRunsForTarget: vi.fn().mockResolvedValue([])
}))

vi.mock('@/lib/launch-agent-background-session', () => ({
  launchAgentBackgroundSession: mockLaunchAgentBackgroundSession
}))

vi.mock('@/lib/automation-session-reuse', () => ({
  findReusableAutomationSession: mockFindReusableAutomationSession
}))

vi.mock('@/lib/agent-session-launch-plan', () => ({
  planAgentSessionLaunch: mockPlanAgentSessionLaunch
}))

vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mockBeginStructuredProvisionalLaunch
}))

vi.mock('@/lib/agent-message-send', () => ({
  sendMessageToAgent: mockSendMessageToAgent
}))

import { handleAutomationDispatchRequest } from './automation-dispatch-handler'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'

describe('automation dispatch structured chat session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    latestStoreSubscriber = null
    state.settings = { experimentalNativeChat: true }
    state.agentStatusByPaneKey = {}
    mockCreateWorktree.mockResolvedValue({
      worktree: {
        id: 'wt-created',
        repoId: 'repo-1',
        displayName: 'Automation worktree',
        path: '/repo/worktree'
      }
    })
    vi.stubGlobal('window', {
      api: {
        automations: {
          markDispatchResult: mockMarkDispatchResult,
          runPrecheck: vi.fn()
        },
        ssh: {
          needsPassphrasePrompt: vi.fn().mockResolvedValue(false),
          getState: vi.fn().mockResolvedValue({ status: 'connected' }),
          connect: vi.fn().mockResolvedValue({ status: 'connected' })
        }
      }
    })
  })

  it('launches a structured chat session when Chat UI is enabled and records completion output', async () => {
    const chatSessionId = 'sess-auto-1'
    const tabId = `structured-agent-session-${chatSessionId}`
    const paneKey = structuredAgentSessionPaneKey(tabId, chatSessionId)

    mockPlanAgentSessionLaunch.mockReturnValue({
      route: 'structured-native-chat',
      requestId: 'run-1',
      agent: 'claude'
    })
    mockBeginStructuredProvisionalLaunch.mockReturnValue({
      tab: { id: tabId, entityId: chatSessionId },
      settlement: Promise.resolve({
        kind: 'structured',
        sessionId: chatSessionId,
        promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
      }),
      cancel: vi.fn()
    })

    await handleAutomationDispatchRequest({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read by the dispatch handler.
      automation: {
        id: 'auto-1',
        projectId: 'repo-1',
        prompt: 'Check the build',
        precheck: null,
        agentId: 'claude',
        workspaceMode: 'new_per_run',
        workspaceId: null,
        baseBranch: null,
        setupDecision: 'skip',
        reuseSession: false
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these run fields are read by the dispatch handler.
      run: {
        id: 'run-1',
        automationId: 'auto-1',
        title: 'Nightly run 1',
        scheduledFor: 1_000,
        trigger: 'scheduled',
        workspaceId: null,
        workspaceDisplayName: null
      } as never,
      dispatchToken: 'token-1'
    })

    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'dispatched',
        workspaceId: 'wt-created',
        sessionKind: 'structured',
        chatSessionId,
        terminalSessionId: tabId,
        terminalPaneKey: paneKey,
        terminalPtyId: null
      })
    )

    const now = Date.now() + 10
    state.agentStatusByPaneKey = {
      [paneKey]: {
        paneKey,
        state: 'done',
        prompt: 'Check the build',
        agentType: 'claude',
        updatedAt: now,
        stateStartedAt: now,
        lastAssistantMessage: 'All checks passed.',
        stateHistory: []
      }
    }
    latestStoreSubscriber?.()

    await vi.waitFor(() =>
      expect(mockMarkDispatchResult).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: 'run-1',
          status: 'completed',
          outputSnapshot: expect.objectContaining({
            content: 'All checks passed.'
          })
        })
      )
    )
  })

  it('reuses an existing structured chat session when reuseSession is enabled', async () => {
    const chatSessionId = 'sess-reuse-1'
    const tabId = `structured-agent-session-${chatSessionId}`
    const paneKey = structuredAgentSessionPaneKey(tabId, chatSessionId)
    state.allWorktrees = vi.fn(() => [
      { id: 'wt-existing', repoId: 'repo-1', displayName: 'Existing', path: '/repo/existing' }
    ])
    mockFindReusableAutomationSession.mockReturnValue({
      kind: 'structured',
      tabId,
      chatSessionId,
      paneKey
    })
    mockSendMessageToAgent.mockResolvedValue({ status: 'sent' })

    await handleAutomationDispatchRequest({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read by the dispatch handler.
      automation: {
        id: 'auto-1',
        projectId: 'repo-1',
        prompt: 'Continue check',
        precheck: null,
        agentId: 'claude',
        workspaceMode: 'existing',
        workspaceId: 'wt-existing',
        baseBranch: null,
        reuseSession: true
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these run fields are read by the dispatch handler.
      run: {
        id: 'run-2',
        automationId: 'auto-1',
        title: 'Nightly run 2',
        scheduledFor: 2_000,
        trigger: 'scheduled',
        workspaceId: 'wt-existing',
        workspaceDisplayName: 'Existing'
      } as never,
      dispatchToken: 'token-2'
    })

    expect(mockSendMessageToAgent).toHaveBeenCalledWith({
      worktreeId: 'wt-existing',
      target: { kind: 'structured-session', sessionId: chatSessionId },
      prompt: 'Continue check'
    })
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-2',
        status: 'dispatched',
        workspaceId: 'wt-existing',
        sessionKind: 'structured',
        chatSessionId,
        terminalSessionId: tabId,
        terminalPaneKey: paneKey,
        terminalPtyId: null
      })
    )
  })

  it('tracks a structured session with visibility-unknown create without falling back to a terminal', async () => {
    const chatSessionId = 'sess-unknown-1'
    const tabId = `structured-agent-session-${chatSessionId}`
    const paneKey = structuredAgentSessionPaneKey(tabId, chatSessionId)

    mockPlanAgentSessionLaunch.mockReturnValue({
      route: 'structured-native-chat',
      requestId: 'run-unknown',
      agent: 'claude'
    })
    mockBeginStructuredProvisionalLaunch.mockReturnValue({
      tab: { id: tabId, entityId: chatSessionId },
      settlement: Promise.resolve({
        kind: 'visibility-unknown',
        sessionId: chatSessionId
      }),
      cancel: vi.fn()
    })

    await handleAutomationDispatchRequest({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read by the dispatch handler.
      automation: {
        id: 'auto-1',
        projectId: 'repo-1',
        prompt: 'Do exactly one job',
        precheck: null,
        agentId: 'claude',
        workspaceMode: 'new_per_run',
        workspaceId: null,
        baseBranch: null,
        setupDecision: 'skip',
        reuseSession: false
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these run fields are read by the dispatch handler.
      run: {
        id: 'run-unknown',
        automationId: 'auto-1',
        title: 'Unknown run',
        scheduledFor: 1_000,
        trigger: 'scheduled',
        workspaceId: null,
        workspaceDisplayName: null
      } as never,
      dispatchToken: 'token-unknown'
    })

    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-unknown',
        status: 'dispatched',
        sessionKind: 'structured',
        chatSessionId,
        terminalSessionId: tabId,
        terminalPaneKey: paneKey
      })
    )
  })

  it('does not fall back to a fresh session when a reused structured send is unconfirmed', async () => {
    const chatSessionId = 'sess-unconfirmed'
    const tabId = `structured-agent-session-${chatSessionId}`
    const paneKey = structuredAgentSessionPaneKey(tabId, chatSessionId)
    state.allWorktrees = vi.fn(() => [
      { id: 'wt-existing', repoId: 'repo-1', displayName: 'Existing', path: '/repo/existing' }
    ])
    mockFindReusableAutomationSession.mockReturnValue({
      kind: 'structured',
      tabId,
      chatSessionId,
      paneKey
    })
    mockSendMessageToAgent.mockResolvedValue({
      status: 'unconfirmed',
      code: 'runtime-unverifiable'
    })

    await handleAutomationDispatchRequest({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read by the dispatch handler.
      automation: {
        id: 'auto-1',
        projectId: 'repo-1',
        prompt: 'Do exactly one job',
        precheck: null,
        agentId: 'claude',
        workspaceMode: 'existing',
        workspaceId: 'wt-existing',
        baseBranch: null,
        reuseSession: true
      } as never,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these run fields are read by the dispatch handler.
      run: {
        id: 'run-unconfirmed',
        automationId: 'auto-1',
        title: 'Unconfirmed run',
        scheduledFor: 2_000,
        trigger: 'scheduled',
        workspaceId: 'wt-existing',
        workspaceDisplayName: 'Existing'
      } as never,
      dispatchToken: 'token-unconfirmed'
    })

    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockBeginStructuredProvisionalLaunch).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-unconfirmed',
        status: 'dispatched',
        sessionKind: 'structured',
        chatSessionId
      })
    )
  })

  it.each(['failure', 'cancellation'] as const)(
    'marks a structured run as dispatch_failed when the turn outcome is %s',
    async (outcome) => {
      const chatSessionId = `sess-${outcome}`
      const tabId = `structured-agent-session-${chatSessionId}`
      const paneKey = structuredAgentSessionPaneKey(tabId, chatSessionId)

      mockPlanAgentSessionLaunch.mockReturnValue({
        route: 'structured-native-chat',
        requestId: `run-${outcome}`,
        agent: 'claude'
      })
      mockBeginStructuredProvisionalLaunch.mockReturnValue({
        tab: { id: tabId, entityId: chatSessionId },
        settlement: Promise.resolve({
          kind: 'structured',
          sessionId: chatSessionId,
          promptDeliveryResult: Promise.resolve({ delivered: true, failureNotified: false })
        }),
        cancel: vi.fn()
      })

      await handleAutomationDispatchRequest({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read by the dispatch handler.
        automation: {
          id: 'auto-1',
          projectId: 'repo-1',
          prompt: 'Check the build',
          precheck: null,
          agentId: 'claude',
          workspaceMode: 'new_per_run',
          workspaceId: null,
          baseBranch: null,
          setupDecision: 'skip',
          reuseSession: false
        } as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these run fields are read by the dispatch handler.
        run: {
          id: `run-${outcome}`,
          automationId: 'auto-1',
          title: 'Nightly run',
          scheduledFor: 1_000,
          trigger: 'scheduled',
          workspaceId: null,
          workspaceDisplayName: null
        } as never,
        dispatchToken: `token-${outcome}`
      })

      const now = Date.now() + 10
      state.agentStatusByPaneKey = {
        [paneKey]: {
          paneKey,
          state: 'done',
          mainAgent: { state: 'done', outcome, stateStartedAt: now },
          prompt: 'Check the build',
          agentType: 'claude',
          updatedAt: now,
          stateStartedAt: now,
          lastAssistantMessage: 'Observed failure output.',
          stateHistory: []
        }
      }
      latestStoreSubscriber?.()

      await vi.waitFor(() =>
        expect(mockMarkDispatchResult).toHaveBeenCalledWith(
          expect.objectContaining({
            runId: `run-${outcome}`,
            status: 'dispatch_failed',
            error: `Automation structured session turn ended with ${outcome}.`
          })
        )
      )
    }
  )
})
