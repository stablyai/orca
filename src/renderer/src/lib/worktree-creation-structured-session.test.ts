import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: { pendingWorktreeCreations: { 'creation-1': {} } } as Record<string, unknown>,
  listener: null as ((state: { pendingWorktreeCreations: Record<string, unknown> }) => void) | null,
  unsubscribe: vi.fn(),
  launchAgentSession: vi.fn(),
  startStructuredAgentLaunch: vi.fn(),
  activateAndRevealWorktree: vi.fn(),
  activateStructuredAgentSessionById: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mocks.state,
    subscribe: vi.fn((listener) => {
      mocks.listener = listener
      return mocks.unsubscribe
    })
  }
}))

vi.mock('@/lib/launch-agent-session', () => ({
  launchAgentSession: mocks.launchAgentSession
}))

import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'

const request = {
  repoId: 'repo-1',
  name: 'routing-recovery',
  setupDecision: 'run' as const,
  agent: 'codex' as const,
  pendingFirstAgentMessageRename: true,
  note: '',
  startupPlan: null,
  quickPrompt: 'Fix the route',
  quickTelemetry: null
}

function args(overrides: Record<string, unknown> = {}) {
  return {
    creationId: 'creation-1',
    request,
    agentLaunchRoute: 'structured-native-chat' as const,
    worktreeId: 'worktree-1',
    shouldActivateOnCompletion: true,
    activation: false as const,
    primaryTabId: null,
    ...overrides
  }
}

describe('launchStructuredWorktreeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state = { pendingWorktreeCreations: { 'creation-1': {} } }
    mocks.listener = null
    mocks.launchAgentSession.mockImplementation(async (launchRequest) => {
      const activation = mocks.activateAndRevealWorktree(launchRequest.workspaceId, {
        providesInitialSurface: true
      })
      mocks.activateStructuredAgentSessionById({
        worktreeId: launchRequest.workspaceId,
        sessionId: 'session-1'
      })
      return {
        kind: 'structured',
        sessionId: 'session-1',
        tabId: 'agent-session:session-1',
        activation
      }
    })
  })

  it('maps a structured launch and threads quick-create ownership fields', async () => {
    mocks.launchAgentSession.mockResolvedValue({ kind: 'structured', sessionId: 's', tabId: 't' })

    await expect(launchStructuredWorktreeSession(args())).resolves.toEqual({
      accepted: true,
      cancelled: false,
      visibilityUnknown: false,
      activation: { primaryTabId: null },
      primaryTabId: null
    })
    expect(mocks.launchAgentSession).toHaveBeenCalledWith({
      agent: 'codex',
      workspaceId: 'worktree-1',
      prompt: 'Fix the route',
      visibility: 'reveal',
      launchSource: 'new_workspace_composer',
      pendingFirstAgentMessageRename: true,
      reconcileUnknownLaunch: undefined,
      signal: expect.any(AbortSignal),
      launchPlan: expect.objectContaining({ route: 'structured-native-chat' })
    })
  })

  it('keeps a background structured launch invisible', async () => {
    mocks.launchAgentSession.mockResolvedValue({ kind: 'structured', sessionId: 's', tabId: 't' })
    await launchStructuredWorktreeSession(args({ shouldActivateOnCompletion: false }))
    expect(mocks.launchAgentSession).toHaveBeenCalledWith(
      expect.objectContaining({ visibility: 'background' })
    )
  })

  it('reconciles an unknown launch without re-staging its prompt', async () => {
    mocks.launchAgentSession.mockResolvedValue({ kind: 'structured', sessionId: 's', tabId: 't' })
    await launchStructuredWorktreeSession(args({ recoverUnknownLaunch: true }))
    const requestArg = mocks.launchAgentSession.mock.calls[0]?.[0]
    expect(requestArg).not.toHaveProperty('prompt')
    expect(requestArg.reconcileUnknownLaunch).toBe(true)
  })

  it('maps terminal refusal, unknown visibility, and failure', async () => {
    mocks.launchAgentSession.mockResolvedValueOnce({
      kind: 'terminal',
      tabId: 'fallback',
      viaRefusal: true
    })
    await expect(launchStructuredWorktreeSession(args())).resolves.toEqual({
      accepted: false,
      cancelled: false,
      visibilityUnknown: false,
      activation: false,
      primaryTabId: 'fallback'
    })
    mocks.launchAgentSession.mockResolvedValueOnce({ kind: 'visibility-unknown', sessionId: 's' })
    await expect(launchStructuredWorktreeSession(args())).resolves.toMatchObject({
      visibilityUnknown: true
    })
    mocks.launchAgentSession.mockResolvedValueOnce({ kind: 'failed', error: new Error('boom') })
    await expect(launchStructuredWorktreeSession(args())).resolves.toMatchObject({ accepted: true })
  })

  it('maps cancellation and preserves a completed fallback surface', async () => {
    mocks.launchAgentSession.mockResolvedValue({
      kind: 'cancelled',
      surface: { tabId: 'fallback' }
    })
    await expect(launchStructuredWorktreeSession(args())).resolves.toMatchObject({
      accepted: false,
      cancelled: true,
      primaryTabId: 'fallback'
    })
  })

  it('aborts the shared launch when the pending creation disappears', async () => {
    let signal: AbortSignal | undefined
    mocks.launchAgentSession.mockImplementation((launchRequest) => {
      signal = launchRequest.signal
      return new Promise((resolve) =>
        signal?.addEventListener('abort', () => resolve({ kind: 'cancelled' }), { once: true })
      )
    })
    const result = launchStructuredWorktreeSession(args())
    mocks.state = { pendingWorktreeCreations: {} }
    mocks.listener?.(mocks.state as { pendingWorktreeCreations: Record<string, unknown> })
    await expect(result).resolves.toMatchObject({ cancelled: true })
    expect(signal?.aborted).toBe(true)
    expect(mocks.unsubscribe).toHaveBeenCalled()
  })

  it('does not launch after the creation has already been dismissed', async () => {
    mocks.state = { pendingWorktreeCreations: {} }
    await expect(launchStructuredWorktreeSession(args())).resolves.toMatchObject({
      cancelled: true
    })
    expect(mocks.launchAgentSession).not.toHaveBeenCalled()
  })

  it('activates the workspace before selecting a chat when creation deferred activation', async () => {
    mocks.startStructuredAgentLaunch.mockReturnValue({
      sessionId: 'session-1',
      launchResult: Promise.resolve({ sessionId: 'session-1', fence: 1 }),
      claimDefinitiveRefusalFallback: vi.fn(() => Promise.resolve(false))
    })
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })

    const result = await launchStructuredWorktreeSession({
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
      agentLaunchRoute: 'structured-native-chat',
      worktreeId: 'worktree-1',
      shouldActivateOnCompletion: true,
      fallbackStartupOpt: undefined,
      activation: false,
      primaryTabId: null
    })

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1', {
      providesInitialSurface: true
    })
    expect(mocks.activateAndRevealWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.activateStructuredAgentSessionById.mock.invocationCallOrder[0]
    )
    expect(result.activation).toEqual({ primaryTabId: null })
  })
})
