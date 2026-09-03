import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    pendingWorktreeCreations: { 'creation-1': {} } as Record<string, unknown>
  },
  listener: null as ((state: { pendingWorktreeCreations: Record<string, unknown> }) => void) | null,
  unsubscribe: vi.fn(),
  startStructuredCodexLaunch: vi.fn(),
  cancelStructuredCodexLaunch: vi.fn(),
  closeStructuredAgentSession: vi.fn(),
  callRuntimeRpc: vi.fn(),
  activateStructuredAgentSessionById: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn(), {
    getState: () => mocks.state,
    subscribe: vi.fn(
      (listener: (state: { pendingWorktreeCreations: Record<string, unknown> }) => void) => {
        mocks.listener = listener
        return mocks.unsubscribe
      }
    )
  })
}))

vi.mock('@/lib/structured-agent-session-launch', () => ({
  startStructuredCodexLaunch: mocks.startStructuredCodexLaunch,
  cancelStructuredCodexLaunch: mocks.cancelStructuredCodexLaunch
}))

vi.mock('@/runtime/structured-agent-session-close', () => ({
  closeStructuredAgentSession: mocks.closeStructuredAgentSession
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc
}))

vi.mock('@/runtime/runtime-worktree-selector', () => ({
  toRuntimeWorktreeSelector: (worktreeId: string) => ({ id: worktreeId })
}))

vi.mock('@/lib/structured-agent-session-tab-activation', () => ({
  activateStructuredAgentSessionById: mocks.activateStructuredAgentSessionById
}))

vi.mock('@/lib/worktree-initial-terminal-seeding', () => ({
  ensureWorktreeHasInitialTerminal: vi.fn()
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/agent-trust-preflight', () => ({
  preflightAgentTrust: vi.fn()
}))

vi.mock('@/lib/launch-structured-codex-session', () => ({
  StructuredAgentSessionCreateRefusalError: class extends Error {}
}))

import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'

describe('launchStructuredWorktreeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state = { pendingWorktreeCreations: { 'creation-1': {} } }
    mocks.listener = null
    mocks.closeStructuredAgentSession.mockResolvedValue('closed')
    mocks.callRuntimeRpc.mockResolvedValue(undefined)
  })

  it('cancels and retires a session when its pending creation is dismissed', async () => {
    let resolveLaunch!: (receipt: { sessionId: string; fence: number }) => void
    const launchResult = new Promise<{ sessionId: string; fence: number }>((resolve) => {
      resolveLaunch = resolve
    })
    mocks.startStructuredCodexLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult,
      isVisibilityUnknown: () => false,
      releaseCallerAfterUnknownOutcome: vi.fn(),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    const resultPromise = launchStructuredWorktreeSession({
      creationId: 'creation-1',
      request: {
        repoId: 'repo-1',
        name: 'routing-recovery',
        setupDecision: 'run',
        agent: 'codex',
        pendingFirstAgentMessageRename: false,
        note: '',
        startupPlan: null,
        quickPrompt: 'Fix the route',
        quickTelemetry: null
      },
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: true,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: null
    })

    mocks.state = { pendingWorktreeCreations: {} }
    mocks.listener?.(mocks.state)
    resolveLaunch({ sessionId: 'session-1', fence: 1 })

    await expect(resultPromise).resolves.toEqual({
      accepted: true,
      cancelled: true,
      visibilityUnknown: false,
      activation: false,
      primaryTabId: null
    })
    expect(mocks.cancelStructuredCodexLaunch).toHaveBeenCalledWith('worktree-1', 'session-1')
    expect(mocks.closeStructuredAgentSession).toHaveBeenCalledWith({ kind: 'local' }, 'session-1')
    expect(mocks.callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'session.tabs.close', {
      worktree: { id: 'worktree-1' },
      tabId: 'agent-session:session-1',
      reason: 'user'
    })
    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })

  it('reports an unknown launch without claiming a visible surface', async () => {
    const releaseCallerAfterUnknownOutcome = vi.fn()
    mocks.startStructuredCodexLaunch.mockReturnValue({
      sessionId: 'session-unknown',
      launchResult: Promise.reject(new Error('connection lost')),
      isVisibilityUnknown: () => true,
      releaseCallerAfterUnknownOutcome,
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })

    await expect(
      launchStructuredWorktreeSession({
        creationId: 'creation-1',
        request: {
          repoId: 'repo-1',
          name: 'routing-recovery',
          setupDecision: 'run',
          agent: 'codex',
          pendingFirstAgentMessageRename: false,
          note: '',
          startupPlan: null,
          quickPrompt: 'Fix the route',
          quickTelemetry: null
        },
        worktreeId: 'worktree-1',
        shouldActivateOnCompletion: true,
        fallbackStartupOpt: undefined,
        activation: false,
        primaryTabId: null
      })
    ).resolves.toEqual({
      accepted: true,
      cancelled: false,
      visibilityUnknown: true,
      activation: false,
      primaryTabId: null
    })

    expect(mocks.activateStructuredAgentSessionById).not.toHaveBeenCalled()
    expect(releaseCallerAfterUnknownOutcome).toHaveBeenCalledOnce()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })
})
