import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockMarkDispatchResult,
  mockCreateWorktree,
  mockLaunchAgentBackgroundSession,
  mockListAutomationRunsForTarget,
  mockFindReusableAutomationSession,
  mockPlanAgentSessionLaunch,
  mockBeginStructuredProvisionalLaunch,
  mockSendMessageToAgent,
  mockSubmitPromptToAgentPty,
  mockObserveExistingAutomationSession
} = vi.hoisted(() => ({
  mockMarkDispatchResult: vi.fn(),
  mockCreateWorktree: vi.fn(),
  mockLaunchAgentBackgroundSession: vi.fn(),
  mockListAutomationRunsForTarget: vi.fn().mockResolvedValue([]),
  mockFindReusableAutomationSession: vi.fn(),
  mockPlanAgentSessionLaunch: vi.fn(),
  mockBeginStructuredProvisionalLaunch: vi.fn(),
  mockSendMessageToAgent: vi.fn(),
  mockSubmitPromptToAgentPty: vi.fn().mockResolvedValue(true),
  mockObserveExistingAutomationSession: vi.fn().mockResolvedValue(() => {})
}))

let latestStoreSubscriber: (() => void) | null = null
function createBaseStoreState(): Record<string, unknown> {
  return {
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
}
let state: Record<string, unknown> = createBaseStoreState()

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
  listAutomationRunsForTarget: mockListAutomationRunsForTarget
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  submitPromptToAgentPty: mockSubmitPromptToAgentPty
}))

vi.mock('@/lib/automation-session-observer', () => ({
  observeExistingAutomationSession: mockObserveExistingAutomationSession
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

import type * as AutomationSessionReuseModule from '@/lib/automation-session-reuse'
import { createAutomationDispatchCompletion } from './automation-dispatch-completion'
import { handleAutomationDispatchRequest } from './automation-dispatch-handler'
import { tryDispatchReusableAutomationSession } from './automation-dispatch-structured-session'
import { resolveAgentStatusLiveEntryMainAgent } from '../store/slices/agent-status-live-entry-main-agent'
import { normalizeAgentStatusPayload } from '../../../shared/agent-status-types'
import { resolveAgentStatusLiveEntryStateHistory } from '../../../shared/agent-status-live-entry-state-history'
import { structuredAgentSessionAgentStatus } from '../../../shared/structured-agent-session-agent-status'
import { structuredAgentSessionPaneKey } from '../../../shared/structured-agent-session-projection'

describe('automation dispatch structured chat session', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockListAutomationRunsForTarget.mockResolvedValue([])
    mockSubmitPromptToAgentPty.mockResolvedValue(true)
    mockObserveExistingAutomationSession.mockResolvedValue(() => {})
    latestStoreSubscriber = null
    state = createBaseStoreState()
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
            error: `Automation agent turn ended with ${outcome}.`
          })
        )
      )
    }
  )

  it.each(['success', 'failure', 'cancellation', 'interruption', 'unconfirmed'] as const)(
    'honors the historical done verdict (%s) when done and next working coalesce in stateHistory',
    async (outcome) => {
      const chatSessionId = `sess-coalesced-${outcome}`
      const tabId = `structured-agent-session-${chatSessionId}`
      const paneKey = structuredAgentSessionPaneKey(tabId, chatSessionId)

      mockPlanAgentSessionLaunch.mockReturnValue({
        route: 'structured-native-chat',
        requestId: `run-coalesced-${outcome}`,
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
          id: `run-coalesced-${outcome}`,
          automationId: 'auto-1',
          title: 'Nightly run',
          scheduledFor: 1_000,
          trigger: 'scheduled',
          workspaceId: null,
          workspaceDisplayName: null
        } as never,
        dispatchToken: `token-coalesced-${outcome}`
      })

      mockMarkDispatchResult.mockClear()
      const baseTime = Date.now() + 10
      const running = {
        paneKey,
        state: 'working' as const,
        prompt: 'Check the build',
        agentType: 'claude' as const,
        updatedAt: baseTime,
        stateStartedAt: baseTime,
        stateHistory: [],
        mainAgent: { state: 'working' as const, stateStartedAt: baseTime }
      }
      const finishedStatus = structuredAgentSessionAgentStatus({
        status: 'idle',
        turnOutcome: outcome
      })
      const doneEntry = {
        ...running,
        ...finishedStatus,
        mainAgent: { ...finishedStatus.mainAgent, stateStartedAt: baseTime + 50 },
        updatedAt: baseTime + 50,
        stateStartedAt: baseTime + 50,
        lastAssistantMessage: 'Automation turn output',
        stateHistory: resolveAgentStatusLiveEntryStateHistory(
          running,
          { state: 'done' },
          baseTime + 50
        ).history
      }
      const next = resolveAgentStatusLiveEntryStateHistory(
        doneEntry,
        { state: 'working' },
        baseTime + 100
      )
      state.agentStatusByPaneKey = {
        [paneKey]: {
          ...running,
          updatedAt: baseTime + 100,
          stateStartedAt: baseTime + 100,
          prompt: 'next input',
          mainAgent: { state: 'working', stateStartedAt: baseTime + 100 },
          stateHistory: next.history,
          lastCompletedAssistantMessage: next.lastCompletedAssistantMessage
        }
      }
      latestStoreSubscriber?.()

      if (outcome === 'unconfirmed') {
        expect(mockMarkDispatchResult).not.toHaveBeenCalled()
      } else {
        const expectedStatus = outcome === 'success' ? 'completed' : 'dispatch_failed'
        await vi.waitFor(() =>
          expect(mockMarkDispatchResult).toHaveBeenCalledWith(
            expect.objectContaining({
              runId: `run-coalesced-${outcome}`,
              status: expectedStatus,
              outputSnapshot: expect.objectContaining({
                content: 'Automation turn output'
              })
            })
          )
        )
      }
    }
  )

  it.each(['success', 'failure', 'cancellation'] as const)(
    'retains pending %s verdict when dual terminal status sources fire before dispatch settles',
    async (outcome) => {
      state.settings = { experimentalNativeChat: false }
      let oscDone: ((payload: Record<string, unknown>) => void) | undefined
      const finalize = vi.fn(async () => null)
      mockLaunchAgentBackgroundSession.mockImplementation(
        async (args: { onAgentStatus: (payload: Record<string, unknown>) => void }) => {
          oscDone = args.onAgentStatus
          return {
            tabId: 'tab-terminal',
            paneKey: 'pane-terminal',
            ptyId: 'pty-terminal',
            releaseRuntimeObservers: () => {},
            terminalOwnership: { release: vi.fn(), finalize }
          }
        }
      )
      mockMarkDispatchResult.mockImplementation(async (result: { status: string }) => {
        if (result.status !== 'dispatched') {
          return
        }
        const now = Date.now() + 10
        state.agentStatusByPaneKey = {
          'pane-terminal': {
            paneKey: 'pane-terminal',
            state: 'done',
            mainAgent: { state: 'done', outcome, stateStartedAt: now },
            prompt: 'Do exactly one job',
            updatedAt: now,
            stateStartedAt: now,
            lastAssistantMessage: 'Turn output',
            stateHistory: []
          }
        }
        latestStoreSubscriber?.()
        oscDone?.({ state: 'done', lastAssistantMessage: 'Turn output' })
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
          id: `run-dual-${outcome}`,
          automationId: 'auto-1',
          title: 'Run',
          scheduledFor: 1_000,
          trigger: 'scheduled',
          workspaceId: null,
          workspaceDisplayName: null
        } as never,
        dispatchToken: `token-dual-${outcome}`
      })

      const finalWrite = mockMarkDispatchResult.mock.calls
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mockMarkDispatchResult receives AutomationDispatchResult objects with a status field.
        .map((call) => call[0] as { status: string })
        .find((call) => call.status !== 'dispatched')
      expect(finalWrite?.status).toBe(outcome === 'success' ? 'completed' : 'dispatch_failed')
      if (outcome !== 'success') {
        expect(finalize).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['stays-idle', 'becomes-busy', 'chat-disabled'] as const)(
    'reads fresh store state after awaiting run history for session reuse (%s)',
    async (change) => {
      const { findReusableAutomationSession: realFindReusableAutomationSession } =
        await vi.importActual<typeof AutomationSessionReuseModule>('@/lib/automation-session-reuse')
      mockFindReusableAutomationSession.mockImplementation(realFindReusableAutomationSession)

      const structured = change === 'chat-disabled'
      const tabId = structured ? 'structured-agent-session-sess-1' : `tab-${change}`
      const leafId = '11111111-1111-4111-8111-111111111111'
      const paneKey = `${tabId}:${leafId}`
      const idleStatus = {
        state: 'done' as const,
        agentType: 'claude' as const,
        paneKey,
        prompt: 'previous',
        updatedAt: 10,
        stateStartedAt: 10,
        stateHistory: []
      }
      const initialSnapshot = {
        ...createBaseStoreState(),
        settings: { experimentalNativeChat: true },
        agentStatusByPaneKey: { [paneKey]: idleStatus },
        ptyIdsByTabId: { [tabId]: ['pty-1'] },
        terminalLayoutsByTabId: { [tabId]: { ptyIdsByLeafId: { [leafId]: 'pty-1' } } },
        unifiedTabsByWorktree: {
          'wt-1': [
            {
              id: tabId,
              contentType: structured ? 'agent-session' : 'terminal',
              entityId: structured ? 'sess-1' : tabId
            }
          ]
        }
      }
      state = initialSnapshot

      let finishHistory: ((runs: unknown[]) => void) | undefined
      mockListAutomationRunsForTarget.mockReturnValue(
        new Promise((resolve) => {
          finishHistory = resolve
        })
      )
      mockSendMessageToAgent.mockResolvedValue({ status: 'sent' })

      let releaseTab = () => {}
      const completion = {
        setReuseDispatchTabRelease: (fn: () => void) => {
          releaseTab = fn
        },
        cleanupRunObservers: () => releaseTab(),
        observeAgentStatus: vi.fn(),
        setSessionObserver: vi.fn(),
        settlePendingAfterDispatch: vi.fn(async () => {}),
        appendOutput: vi.fn(),
        handleExit: vi.fn(),
        handleAgentDone: vi.fn(),
        captureAssistantMessage: vi.fn()
      }

      const promise = tryDispatchReusableAutomationSession({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only these automation fields are read by tryDispatchReusableAutomationSession.
        automation: { id: 'auto-1', agentId: 'claude', prompt: 'automation input' } as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only run.id is read.
        run: { id: 'current' } as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only worktree.id and displayName are read.
        worktree: { id: 'wt-1', displayName: 'Workspace' } as never,
        precheckResult: null,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test stub provides all completion methods used by reuse dispatch.
        completion: completion as never,
        markDispatchResult: vi.fn(async () => {})
      })

      if (change === 'becomes-busy') {
        state = {
          ...initialSnapshot,
          agentStatusByPaneKey: {
            [paneKey]: {
              ...idleStatus,
              state: 'working',
              prompt: 'user task',
              updatedAt: 20,
              stateStartedAt: 20
            }
          }
        }
      }
      if (change === 'chat-disabled') {
        state = {
          ...initialSnapshot,
          settings: { experimentalNativeChat: false }
        }
      }

      finishHistory?.([
        {
          id: 'old',
          automationId: 'auto-1',
          workspaceId: 'wt-1',
          status: 'completed',
          sessionKind: structured ? 'structured' : 'terminal',
          chatSessionId: structured ? 'sess-1' : null,
          terminalSessionId: tabId,
          terminalPaneKey: paneKey,
          terminalPtyId: structured ? null : 'pty-1',
          createdAt: 1,
          dispatchedAt: 1
        }
      ])

      const reused = await promise
      releaseTab()
      expect(reused).toBe(change === 'stays-idle')
      if (change !== 'stays-idle') {
        expect(mockSubmitPromptToAgentPty).not.toHaveBeenCalled()
        expect(mockSendMessageToAgent).not.toHaveBeenCalled()
      }
    }
  )

  it.each(['live-cancel', 'history-cancel', 'legacy-done'] as const)(
    'honors legacy interrupted wire verdict through agentMainAgentVerdict (%s)',
    async (kind) => {
      const payload = normalizeAgentStatusPayload({
        state: 'done',
        prompt: 'job',
        agentType: 'claude',
        ...(kind !== 'legacy-done' ? { interrupted: true } : {})
      })!
      const mainAgent = resolveAgentStatusLiveEntryMainAgent(undefined, payload, 'claude')
      const doneEntry = {
        ...payload,
        paneKey: 'pane-legacy',
        stateStartedAt: 200,
        updatedAt: 200,
        stateHistory: [],
        mainAgent,
        lastAssistantMessage: 'Turn output'
      }
      let entry: Record<string, unknown> = doneEntry
      if (kind === 'history-cancel') {
        const next = resolveAgentStatusLiveEntryStateHistory(doneEntry, { state: 'working' }, 300)
        entry = {
          state: 'working',
          prompt: 'next',
          paneKey: 'pane-legacy',
          updatedAt: 300,
          stateStartedAt: 300,
          stateHistory: next.history,
          lastCompletedAssistantMessage: next.lastCompletedAssistantMessage
        }
      }
      state.agentStatusByPaneKey = { 'pane-legacy': entry }
      const writes: { status: string }[] = []
      const completion = createAutomationDispatchCompletion({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only run.id is read.
        run: { id: `run-${kind}` } as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only worktree.id and displayName are read.
        worktree: { id: 'wt-1', displayName: 'Workspace' } as never,
        precheckResult: null,
        markDispatchResult: async (result) => {
          writes.push(result)
        },
        releaseTerminalOwnership: () => {},
        finalizeTerminalOwnership: async () => null
      })
      completion.observeAgentStatus('pane-legacy', 100)
      await completion.settlePendingAfterDispatch()
      expect(writes[0]?.status).toBe(kind === 'legacy-done' ? 'completed' : 'dispatch_failed')
    }
  )
})
