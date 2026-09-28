import { beforeEach, describe, expect, it, vi } from 'vitest'

type PendingCreationState = { pendingWorktreeCreations: Record<string, unknown> }
type PendingCreationListener = (state: PendingCreationState) => void
type BeginArgs = {
  beforeOpen?: (sessionId: string) => boolean | void
  hooks?: { signal?: AbortSignal }
}
const mocks = vi.hoisted(() => {
  let listener: PendingCreationListener | null = null
  return {
    state: {
      pendingWorktreeCreations: Object.fromEntries([['creation-1', {}]]),
      updatePendingWorktreeCreation: vi.fn<(id: string, patch: unknown) => void>()
    },
    get listener() {
      return listener
    },
    set listener(value: PendingCreationListener | null) {
      listener = value
    },
    unsubscribe: vi.fn<() => void>(),
    beginStructuredAgentSessionProvisionalLaunch:
      vi.fn<(args: BeginArgs) => { sessionId: string; tab: { id: string } } | null>(),
    activateAndRevealWorktree: vi.fn<(worktreeId: string, options?: unknown) => unknown>()
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(vi.fn<() => unknown>(), {
    getState: () => mocks.state,
    subscribe: vi.fn<(listener: PendingCreationListener) => () => void>(
      (listener: PendingCreationListener) => {
        mocks.listener = listener
        return mocks.unsubscribe
      }
    )
  })
}))

vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'

const request = {
  repoId: 'repo-1',
  name: 'routing-recovery',
  setupDecision: 'run' as const,
  agent: 'codex' as const,
  agentLaunchRoute: 'structured-native-chat' as const,
  pendingFirstAgentMessageRename: true,
  note: '',
  startupPlan: null,
  quickPrompt: 'Fix the route',
  quickTelemetry: null
}

const baseArgs = {
  creationId: 'creation-1',
  request,
  agentLaunchRoute: 'structured-native-chat' as const,
  worktreeId: 'worktree-1',
  shouldActivateOnCompletion: true,
  activation: false as const,
  primaryTabId: null
}

describe('launchStructuredWorktreeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.pendingWorktreeCreations = Object.fromEntries([['creation-1', {}]])
    mocks.listener = null
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.beforeOpen?.('session-1')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })
  })

  it('reveals the created workspace before opening its final-id chat tab', async () => {
    const order: string[] = []
    mocks.activateAndRevealWorktree.mockImplementation(() => {
      order.push('reveal')
      return { primaryTabId: null }
    })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      order.push('begin')
      args.beforeOpen?.('session-1')
      order.push('open')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })

    await expect(launchStructuredWorktreeSession(baseArgs)).resolves.toEqual({
      accepted: true,
      cancelled: false,
      activation: { primaryTabId: null },
      primaryTabId: 'agent-session:session-1'
    })
    expect(order).toEqual(['begin', 'reveal', 'open'])
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { worktreeId: 'worktree-1' },
        activate: true,
        plan: expect.objectContaining({
          route: 'structured-native-chat',
          agent: 'codex',
          prompt: 'Fix the route'
        })
      })
    )
  })

  it('does not launch after the pending creation was cancelled', async () => {
    mocks.state.pendingWorktreeCreations = {}

    await expect(launchStructuredWorktreeSession(baseArgs)).resolves.toMatchObject({
      accepted: true,
      cancelled: true,
      primaryTabId: null
    })
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).not.toHaveBeenCalled()
  })

  it('keeps deferred activation from selecting the provisional tab', async () => {
    await expect(
      launchStructuredWorktreeSession({
        ...baseArgs,
        shouldActivateOnCompletion: false,
        primaryTabId: 'existing-tab'
      })
    ).resolves.toMatchObject({ primaryTabId: 'agent-session:session-1' })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).toHaveBeenCalledWith(
      expect.objectContaining({ activate: false })
    )
  })

  it('does not open a tab when cancellation races the reveal callback', async () => {
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      const pending = mocks.state.pendingWorktreeCreations
      mocks.state.pendingWorktreeCreations = {}
      mocks.listener?.(mocks.state)
      mocks.state.pendingWorktreeCreations = pending
      const allowed = args.beforeOpen?.('session-1')
      return allowed === false
        ? null
        : { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })

    await expect(launchStructuredWorktreeSession(baseArgs)).resolves.toMatchObject({
      accepted: true,
      cancelled: false,
      primaryTabId: null
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
