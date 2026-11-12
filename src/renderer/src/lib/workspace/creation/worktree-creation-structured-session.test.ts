import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNativeChatComposerDraftsForTests } from '@/components/native-chat/drafts/native-chat-draft-reset'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '@/components/native-chat/drafts/native-chat-composer-draft-store'

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

vi.mock('@/store/index', () => ({
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

vi.mock('@/lib/agent-session/launch/new-tab/launch-agent-in-new-tab', () => ({
  launchAgentInNewTabWithOutcome: mocks.launchAgentInNewTabWithOutcome
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/components/native-chat/composer/focus/native-chat-composer-mount', () => ({
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
    mocks.state.pendingWorktreeCreations = { 'creation-1': { request } }
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
})
