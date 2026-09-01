// Workspace-resolution half of the dispatch suite: setup launch, folder/SSH
// workspace targeting, and pre-launch skips. Session lifecycle and terminal
// ownership live in useAutomationDispatchEvents.session-lifecycle.test.ts.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  automationRunOutputSnapshotMock,
  createdWorktree,
  makeAutomation,
  mockCreateWorktree,
  mockFindReusableAutomationSession,
  mockLaunchAgentBackgroundSession,
  mockLaunchWorktreeBackgroundTerminals,
  mockMarkDispatchResult,
  mockObserveExistingAutomationSession,
  mockSshConnect,
  mockSshGetState,
  mockSshNeedsPassphrasePrompt,
  mockStoreSubscribe,
  mockSubmitPromptToAgentPty,
  registerAndDispatch,
  resetAutomationDispatchHarness,
  setupLaunch,
  state
} from './automation-dispatch-events-test-harness'

vi.mock('@/lib/launch-agent-background-session', () => ({
  launchAgentBackgroundSession: mockLaunchAgentBackgroundSession
}))

vi.mock('@/lib/launch-worktree-background-terminals', () => ({
  launchWorktreeBackgroundTerminals: mockLaunchWorktreeBackgroundTerminals
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  submitPromptToAgentPty: mockSubmitPromptToAgentPty
}))

vi.mock('@/lib/automation-session-reuse', () => ({
  findReusableAutomationSession: mockFindReusableAutomationSession
}))

vi.mock('@/lib/automation-session-observer', () => ({
  observeExistingAutomationSession: mockObserveExistingAutomationSession
}))

vi.mock(
  '@/components/automations/automation-run-output-snapshot',
  () => automationRunOutputSnapshotMock
)

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/browser-uuid', () => ({
  createBrowserUuid: () => 'create-request-id'
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: mockStoreSubscribe
  }
}))

describe('useAutomationDispatchEvents setup launch', () => {
  beforeEach(() => {
    resetAutomationDispatchHarness()
  })

  it('starts setup terminal launch without waiting before launching the automation agent', async () => {
    const order: string[] = []
    let finishSetupLaunch: (() => void) | null = null
    mockLaunchWorktreeBackgroundTerminals.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSetupLaunch = () => {
            order.push('setup')
            resolve()
          }
        })
    )
    mockLaunchAgentBackgroundSession.mockImplementation(async () => {
      order.push('agent')
      return { tabId: 'agent-tab', ptyId: 'agent-pty', startupPlan: {} }
    })

    await registerAndDispatch()

    expect(mockCreateWorktree).toHaveBeenCalled()
    expect(mockCreateWorktree.mock.calls[0][3]).toBe('run')
    expect(mockLaunchWorktreeBackgroundTerminals).toHaveBeenCalledWith({
      worktreeId: 'wt-created',
      setup: setupLaunch,
      defaultTabs: undefined
    })
    expect(state.setActiveView).not.toHaveBeenCalled()
    expect(state.setActiveWorktree).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-created',
        prompt: 'run this'
      })
    )
    expect(order).toEqual(['agent'])
    expect(finishSetupLaunch).not.toBeNull()
    const completeSetupLaunch = finishSetupLaunch as unknown as () => void
    completeSetupLaunch()
    await Promise.resolve()
    expect(order).toEqual(['agent', 'setup'])
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'dispatched',
        workspaceId: 'wt-created',
        terminalSessionId: 'agent-tab'
      })
    )
  })

  it('launches setup and default tabs without activating the created worktree', async () => {
    const defaultTabs = {
      tabs: [{ title: 'Dev', command: 'pnpm dev' }],
      runCommands: true
    }
    mockCreateWorktree.mockResolvedValue({
      worktree: createdWorktree,
      setup: setupLaunch,
      defaultTabs
    })

    await registerAndDispatch()

    expect(mockLaunchWorktreeBackgroundTerminals).toHaveBeenCalledWith({
      worktreeId: 'wt-created',
      setup: setupLaunch,
      defaultTabs
    })
    expect(state.setActiveView).not.toHaveBeenCalled()
    expect(state.setActiveWorktree).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-created',
        prompt: 'run this'
      })
    )
  })

  it('defaults legacy automations without a setup choice to skipping setup', async () => {
    await registerAndDispatch(makeAutomation({ setupDecision: undefined }))

    expect(mockCreateWorktree.mock.calls[0][3]).toBe('skip')
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalled()
  })

  it('does not stamp the created workspace with an empty agent-launch fallback', async () => {
    await registerAndDispatch()

    expect(mockCreateWorktree.mock.calls[0][10]).toBeUndefined()
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        prompt: 'run this',
        worktreeId: 'wt-created'
      })
    )
  })

  it('keeps launching the agent when background setup terminal launch fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockLaunchWorktreeBackgroundTerminals.mockRejectedValue(new Error('tab launch failed'))

    try {
      await registerAndDispatch()
    } finally {
      warnSpy.mockRestore()
    }

    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-created',
        prompt: 'run this'
      })
    )
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-1',
        status: 'dispatched',
        workspaceId: 'wt-created',
        terminalSessionId: 'agent-tab'
      })
    )
  })

  it('persists the structured launch failure and the generic string on a typed spawn failure', async () => {
    // Import the error class within this reset-modules cycle so its identity
    // matches the freshly re-imported hook's `instanceof` check.
    const { AgentLaunchSpawnOutcomeError } = await import('@/lib/agent-launch-spawn-outcome-error')
    mockLaunchAgentBackgroundSession.mockRejectedValue(
      new AgentLaunchSpawnOutcomeError({
        status: 'failed',
        failure: { code: 'custom_agent_disabled' }
      })
    )

    await registerAndDispatch()

    const failedCall = mockMarkDispatchResult.mock.calls.find(
      (call) => call[0]?.status === 'dispatch_failed'
    )
    expect(failedCall).toBeDefined()
    // The renderer passes the PLAIN failure; the durable wrapper
    // (version/failureId/intent/occurredAt) is minted host-side at the single
    // markDispatchResult persist authority, so it never crosses this boundary.
    expect(failedCall?.[0]).toEqual(
      expect.objectContaining({
        runId: 'run-1',
        status: 'dispatch_failed',
        error: expect.any(String),
        agentLaunchFailure: { code: 'custom_agent_disabled' }
      })
    )
  })

  it('writes only the generic string when a spawn failure is untyped', async () => {
    mockLaunchAgentBackgroundSession.mockRejectedValue(new Error('boom'))

    await registerAndDispatch()

    const failedCall = mockMarkDispatchResult.mock.calls.find(
      (call) => call[0]?.status === 'dispatch_failed'
    )
    expect(failedCall).toBeDefined()
    expect(failedCall?.[0].error).toBe('boom')
    expect(failedCall?.[0]).not.toHaveProperty('agentLaunchFailure')
  })

  it('does not rerun setup for existing-worktree automations', async () => {
    const existingWorktree = {
      id: 'wt-existing',
      repoId: 'repo-1',
      displayName: 'Existing workspace',
      path: '/repo/existing'
    }
    state.allWorktrees.mockReturnValue([existingWorktree])

    await registerAndDispatch(
      makeAutomation({
        workspaceMode: 'existing',
        workspaceId: 'wt-existing',
        setupDecision: 'run'
      })
    )

    expect(mockCreateWorktree).not.toHaveBeenCalled()
    expect(mockLaunchWorktreeBackgroundTerminals).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-existing',
        prompt: 'run this'
      })
    )
  })

  it('dispatches an existing SSH folder workspace on its resolved host', async () => {
    const folderWorkspace = {
      id: 'folder:fw-1',
      repoId: 'folder-workspace:group-1',
      displayName: 'SSH folder',
      path: '/srv/project'
    }
    state.repos = [
      {
        id: 'repo-1',
        connectionId: 'ssh-folder',
        executionHostId: null,
        path: '/srv/project/repo'
      }
    ]
    state.folderWorkspaces = [
      {
        id: 'fw-1',
        projectGroupId: 'group-1',
        folderPath: '/srv/project',
        connectionId: 'ssh-folder'
      }
    ]
    state.projectGroups = [{ id: 'group-1', connectionId: 'ssh-folder' }]
    state.getKnownWorktreeById.mockReturnValue(folderWorkspace)
    mockSshGetState.mockResolvedValue({ status: 'disconnected' })

    await registerAndDispatch(
      makeAutomation({
        workspaceMode: 'existing',
        workspaceId: folderWorkspace.id,
        setupDecision: 'skip',
        runContext: { repoId: 'repo-1', hostId: 'ssh:ssh-folder' }
      })
    )

    expect(state.allWorktrees).not.toHaveBeenCalled()
    expect(mockSshConnect).toHaveBeenCalledWith({ targetId: 'ssh-folder' })
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: folderWorkspace.id,
        prompt: 'run this'
      })
    )
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'dispatched',
        workspaceId: folderWorkspace.id,
        workspaceDisplayName: folderWorkspace.displayName
      })
    )
  })

  it('dispatches a local folder workspace without SSH', async () => {
    const folderWorkspace = {
      id: 'folder:fw-local',
      repoId: 'folder-workspace:group-local',
      displayName: 'Local folder',
      path: '/project'
    }
    state.folderWorkspaces = [
      {
        id: 'fw-local',
        projectGroupId: 'group-local',
        folderPath: '/project',
        connectionId: null
      }
    ]
    state.projectGroups = [{ id: 'group-local', connectionId: null }]
    state.getKnownWorktreeById.mockReturnValue(folderWorkspace)

    await registerAndDispatch(
      makeAutomation({
        workspaceMode: 'existing',
        workspaceId: folderWorkspace.id,
        runContext: { repoId: 'repo-1', hostId: 'local' }
      })
    )

    expect(mockSshNeedsPassphrasePrompt).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: folderWorkspace.id })
    )
  })

  it('skips a folder workspace owned by a different host', async () => {
    const folderWorkspace = {
      id: 'folder:fw-other',
      repoId: 'folder-workspace:group-other',
      displayName: 'Other host',
      path: '/srv/other'
    }
    state.folderWorkspaces = [
      {
        id: 'fw-other',
        projectGroupId: 'group-other',
        folderPath: '/srv/other',
        connectionId: 'ssh-other'
      }
    ]
    state.projectGroups = [{ id: 'group-other', connectionId: 'ssh-other' }]
    state.getKnownWorktreeById.mockReturnValue(folderWorkspace)

    await registerAndDispatch(
      makeAutomation({
        workspaceMode: 'existing',
        workspaceId: folderWorkspace.id,
        runContext: { repoId: 'repo-1', hostId: 'local' }
      })
    )

    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped_unavailable' })
    )
  })

  it('keeps detected-only non-folder workspaces unavailable', async () => {
    state.getKnownWorktreeById.mockReturnValue({
      id: 'wt-detected',
      repoId: 'repo-1',
      displayName: 'Detected',
      path: '/repo/detected'
    })

    await registerAndDispatch(
      makeAutomation({
        workspaceMode: 'existing',
        workspaceId: 'wt-detected'
      })
    )

    expect(state.getKnownWorktreeById).not.toHaveBeenCalled()
    expect(mockLaunchAgentBackgroundSession).not.toHaveBeenCalled()
    expect(mockMarkDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'skipped_unavailable' })
    )
  })
})
