import { beforeEach, describe, expect, it, vi } from 'vitest'

type PendingCreationState = { pendingWorktreeCreations: Record<string, unknown> }
type PendingCreationListener = (state: PendingCreationState) => void
type BeginArgs = {
  beforeOpen?: (sessionId: string) => boolean | void
  hooks?: { signal?: AbortSignal }
  onTabOpenSettled?: (tabId: string | null, reason?: 'layout-refused') => void
  plan?: { prompt?: string; promptDelivery?: string; draftFromScope?: string }
}
const mocks = vi.hoisted(() => {
  let listener: PendingCreationListener | null = null
  const state: PendingCreationState & {
    activeView: string
    activePendingCreationId: string | null
    updatePendingWorktreeCreation: (id: string, patch: unknown) => void
  } = {
    activeView: 'terminal',
    activePendingCreationId: 'creation-1',
    pendingWorktreeCreations: Object.fromEntries([['creation-1', {}]]),
    updatePendingWorktreeCreation: vi.fn<(id: string, patch: unknown) => void>()
  }
  return {
    state,
    get listener() {
      return listener
    },
    set listener(value: PendingCreationListener | null) {
      listener = value
    },
    unsubscribe: vi.fn<() => void>(),
    launchAgentInNewTabWithOutcome: vi.fn(),
    beginStructuredAgentSessionProvisionalLaunch: vi.fn<
      (args: BeginArgs) => {
        sessionId: string
        tab: { id: string }
        settlement: Promise<{ kind: 'structured'; sessionId: string }>
        cancel: () => void
      } | null
    >(),
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

vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: mocks.launchAgentInNewTabWithOutcome
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

function launchHandle() {
  return {
    sessionId: 'session-1',
    tab: { id: 'agent-session:session-1' },
    settlement: new Promise<{ kind: 'structured'; sessionId: string }>(() => {}),
    cancel: vi.fn()
  }
}

describe('launchStructuredWorktreeSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.pendingWorktreeCreations = Object.fromEntries([['creation-1', {}]])
    mocks.launchAgentInNewTabWithOutcome.mockReturnValue(null)
    mocks.listener = null
    mocks.state.activePendingCreationId = 'creation-1'
    mocks.state.activeView = 'terminal'
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.beforeOpen?.('session-1')
      args.onTabOpenSettled?.('agent-session:session-1')
      return launchHandle()
    })
  })

  it('uses the normal workspace surface when no chat tab is published', async () => {
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.onTabOpenSettled?.(null)
      return launchHandle()
    })
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: 'fallback-terminal' })

    await expect(launchStructuredWorktreeSession(baseArgs)).resolves.toMatchObject({
      primaryTabId: 'fallback-terminal'
    })
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('worktree-1', {
      providesInitialSurface: false,
      worktreeCreationId: 'creation-1'
    })
  })

  it.each([true, false])('recovers a held prompt after no tab, visible: %s', async (visible) => {
    mocks.state.pendingWorktreeCreations = {
      'creation-1': { phase: 'creating', heldChatMessage: 'Add a test', request }
    }
    if (!visible) {
      mocks.state.activePendingCreationId = null
    }
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.onTabOpenSettled?.(null, 'layout-refused')
      return launchHandle()
    })
    mocks.launchAgentInNewTabWithOutcome.mockReturnValue({
      surface: { kind: 'local-terminal', tabId: 'recovered-terminal' }
    })

    await expect(launchStructuredWorktreeSession(baseArgs)).resolves.toMatchObject({
      primaryTabId: 'recovered-terminal'
    })
    expect(mocks.launchAgentInNewTabWithOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Add a test',
        promptDelivery: 'auto-submit',
        activate: visible,
        agentSessionLaunchPlan: expect.objectContaining({ route: 'terminal-tui' })
      })
    )
    if (!visible) {
      expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    }
  })

  it.each(['workspace', 'view'] as const)(
    'preserves %s navigation while waiting for the replacement chat',
    async (navigation) => {
      let openTab: BeginArgs['onTabOpenSettled']
      mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
        openTab = args.onTabOpenSettled
        return launchHandle()
      })

      const completion = launchStructuredWorktreeSession(baseArgs)
      if (navigation === 'workspace') {
        mocks.state.activePendingCreationId = null
      } else {
        mocks.state.activeView = 'tasks'
      }
      openTab?.('agent-session:session-1')
      await completion
      expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    }
  )

  it('cancels a launch dismissed while waiting for its chat tab', async () => {
    const launch = launchHandle()
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockReturnValue(launch)

    const completion = launchStructuredWorktreeSession(baseArgs)
    mocks.state.pendingWorktreeCreations = {}
    mocks.listener?.(mocks.state)

    await expect(completion).resolves.toMatchObject({ cancelled: true })
    expect(launch.cancel).toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
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

  it('does not open a tab when cancellation races the reveal callback', async () => {
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      const pending = mocks.state.pendingWorktreeCreations
      mocks.state.pendingWorktreeCreations = {}
      mocks.listener?.(mocks.state)
      mocks.state.pendingWorktreeCreations = pending
      const allowed = args.beforeOpen?.('session-1')
      return allowed === false ? null : launchHandle()
    })

    await expect(launchStructuredWorktreeSession(baseArgs)).resolves.toMatchObject({
      accepted: true,
      cancelled: false,
      primaryTabId: null
    })
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('logs a chat tab that throws while opening instead of dropping it silently', async () => {
    const failure = new Error('tab store unavailable')
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation(() => {
      throw failure
    })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(launchStructuredWorktreeSession(baseArgs)).resolves.toMatchObject({
      accepted: true,
      primaryTabId: null
    })
    expect(consoleError).toHaveBeenCalledWith(
      'worktree create: structured chat tab failed to open',
      'worktree-1',
      failure
    )
    expect(mocks.unsubscribe).toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('sends what the user wrote while the worktree was created as the first message', async () => {
    mocks.state.pendingWorktreeCreations = {
      'creation-1': { phase: 'creating', heldChatMessage: 'Add a test', request }
    }

    await launchStructuredWorktreeSession(baseArgs)

    expect(mocks.beginStructuredAgentSessionProvisionalLaunch.mock.calls[0][0].plan).toMatchObject({
      prompt: 'Add a test',
      promptDelivery: 'auto-submit',
      draftFromScope: 'pending-worktree-creation:creation-1'
    })
  })

  it('leaves a linked item draft to the pending composer draft the launch moves over', async () => {
    const linked = {
      ...request,
      quickPrompt: '',
      launchDraftPrompt: 'Issue #12',
      promptDelivery: 'draft' as const
    }
    mocks.state.pendingWorktreeCreations = { 'creation-1': { phase: 'creating', request: linked } }

    await launchStructuredWorktreeSession({ ...baseArgs, request: linked })

    expect(mocks.beginStructuredAgentSessionProvisionalLaunch.mock.calls[0][0].plan).toMatchObject({
      prompt: '',
      draftFromScope: 'pending-worktree-creation:creation-1'
    })
  })
})
