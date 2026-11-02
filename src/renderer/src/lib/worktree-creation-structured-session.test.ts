import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/native-chat-composer-draft-store'

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
    unifiedTabsByWorktree: Record<string, never[]>
    updatePendingWorktreeCreation: (id: string, patch: unknown) => void
    getTab: (id: string) => {
      id: string
      contentType: 'agent-session'
      entityId: string
      executionHostId: 'local'
    } | null
  } = {
    activeView: 'terminal',
    activePendingCreationId: 'creation-1',
    unifiedTabsByWorktree: {},
    pendingWorktreeCreations: Object.fromEntries([['creation-1', {}]]),
    updatePendingWorktreeCreation: vi.fn<(id: string, patch: unknown) => void>(),
    getTab: (id) =>
      id === 'agent-session:session-1'
        ? { id, contentType: 'agent-session', entityId: 'session-1', executionHostId: 'local' }
        : null
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
    waitForComposerMount: vi.fn<
      (_source: string, _destination: string, signal: AbortSignal) => Promise<void>
    >(async () => {}),
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
vi.mock('@/components/native-chat/native-chat-composer-mount', () => ({
  nativeChatComposerSelection: () => undefined,
  waitForNativeChatComposerHandoff: mocks.waitForComposerMount
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: vi.fn()
}))

import { launchStructuredWorktreeSession } from './worktree-creation-structured-session'
import { requestBackgroundTerminalWorktreeMount } from '@/components/terminal/background-terminal-worktree-mount'

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
    mocks.waitForComposerMount.mockResolvedValue(undefined)
    clearNativeChatComposerDraftsForTests()
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
      promptDelivery: 'auto-submit'
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
      prompt: ''
    })
  })

  it.each([true, false])(
    'moves the latest unsent typing only when the replacement is published, foreground: %s',
    async (foreground) => {
      const source = 'pending-worktree-creation:creation-1'
      const destination = 'agent-session:session-1'
      let openTab: BeginArgs['onTabOpenSettled']
      mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
        openTab = args.onTabOpenSettled
        return launchHandle()
      })
      updateNativeChatComposerDraft(source, { text: 'Half a prompt' }, 'immediate')
      const completion = launchStructuredWorktreeSession({
        ...baseArgs,
        shouldActivateOnCompletion: foreground
      })

      expect(readNativeChatComposerDraft(source).text).toBe('Half a prompt')
      expect(readNativeChatComposerDraft(destination).text).toBe('')
      updateNativeChatComposerDraft(
        source,
        { text: 'Half a prompt, finished while opening' },
        'immediate'
      )
      openTab?.('agent-session:session-1')
      await completion

      expect(readNativeChatComposerDraft(destination).text).toBe(
        'Half a prompt, finished while opening'
      )
      expect(readNativeChatComposerDraft(source).text).toBe('')
    }
  )

  it('keeps unsent text when the replacement tab is refused', async () => {
    const source = 'pending-worktree-creation:creation-1'
    updateNativeChatComposerDraft(source, { text: 'Keep this draft' }, 'immediate')
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.onTabOpenSettled?.(null, 'layout-refused')
      return launchHandle()
    })

    await launchStructuredWorktreeSession(baseArgs)

    expect(readNativeChatComposerDraft(source).text).toBe('Keep this draft')
  })

  it('keeps the pending draft editable until the published chat editor mounts', async () => {
    const mounted = Promise.withResolvers<void>()
    mocks.waitForComposerMount.mockReturnValue(mounted.promise)
    const source = 'pending-worktree-creation:creation-1'
    updateNativeChatComposerDraft(source, { text: 'Before publication' }, 'immediate')

    const completion = launchStructuredWorktreeSession(baseArgs)
    await Promise.resolve()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(readNativeChatComposerDraft(source).text).toBe('Before publication')
    updateNativeChatComposerDraft(
      source,
      { text: 'Still typing while the editor mounts' },
      'immediate'
    )
    expect(requestBackgroundTerminalWorktreeMount).toHaveBeenCalledWith({
      worktreeId: 'worktree-1',
      tabIds: [expect.any(String)]
    })
    mounted.resolve()
    await completion

    expect(readNativeChatComposerDraft('agent-session:session-1').text).toBe(
      'Still typing while the editor mounts'
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledOnce()
  })

  it('finishes in the background after navigation while the replacement mounts', async () => {
    mocks.waitForComposerMount.mockImplementation(
      (_source, _destination, signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
    )
    const completion = launchStructuredWorktreeSession(baseArgs)
    await Promise.resolve()
    mocks.state.activeView = 'tasks'
    mocks.listener?.(mocks.state)

    await completion

    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
    expect(mocks.unsubscribe).toHaveBeenCalled()
  })

  it('keeps both newer typing and a first message returned by a failed launch', async () => {
    updateNativeChatComposerDraft(
      'agent-session:session-1',
      { text: 'Returned first message' },
      'immediate'
    )
    updateNativeChatComposerDraft(
      'pending-worktree-creation:creation-1',
      { text: 'Newer follow-up' },
      'immediate'
    )

    await launchStructuredWorktreeSession(baseArgs)

    expect(readNativeChatComposerDraft('agent-session:session-1').text).toBe(
      'Returned first message\n\nNewer follow-up'
    )
  })
})
