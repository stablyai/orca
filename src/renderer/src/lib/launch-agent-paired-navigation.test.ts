import { beginDesktopNavigation } from '@/lib/desktop-navigation-request'
import { peekWebSessionFocusIntent } from '@/runtime/web-session-focus-intent'
import { captureWebSessionIntentOwner } from '@/runtime/web-runtime-session-environment'
import { afterEach, expect, it, vi } from 'vitest'
import {
  ENVIRONMENT_ID,
  RUNTIME_EXECUTION_HOST_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from '@/runtime/web-runtime-session-test-harness'
import { stubRuntimeEnvironmentBridge } from '@/runtime/runtime-environment-bridge-fixture'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  subscribe: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  closeEmptyGroup: vi.fn(),
  moveUnifiedTabToGroup: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyWebSessionTabsSnapshot: vi.fn(),
  decideWebSessionTabsSnapshot: vi.fn(() => ({ apply: true, settlesHostMirror: true })),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('@/runtime/web-session-tabs-sync/tracking-lifecycle', async (original) => ({
  ...(await original<object>()),
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot
}))
vi.mock('@/runtime/web-session-tabs-sync/snapshot-api', () => ({
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot
}))
vi.mock('@/runtime/web-session-tabs-sync/tracking-decisions', () => ({
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot
}))
vi.mock('@/runtime/web-session-tabs-sync/store-patch', () => ({
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    return () => {}
  }
}))
vi.mock('@/runtime/web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('@/runtime/web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

const prep = vi.hoisted(() => ({ preferences: vi.fn() }))
vi.mock('@/lib/launch-agent-execution-context', () => ({
  resolveAgentLaunchExecutionContext: () => ({
    resolvedLaunchPlatform: 'linux',
    isRemote: true,
    queuedShell: 'posix'
  })
}))
vi.mock('@/lib/worktree-runtime-owner', async (original) => ({
  ...(await original<object>()),
  runtimeEnvironmentIdOrLocalUnlessTwin: () => ENVIRONMENT_ID
}))
vi.mock('@/lib/launch-work-item-direct-messages', () => ({
  validateActionTerminalArgs: () => true
}))
vi.mock('@/lib/launch-agent-startup-prompt-plan', () => ({
  planLaunchAgentStartupPrompt: () => ({
    startupPlan: { launchCommand: 'codex', launchConfig: { agent: 'codex', agentArgs: '' } },
    pasteDraftAfterLaunch: null,
    submitPastedPrompt: false
  })
}))
vi.mock('@/components/settings/agent-launch-settings-transport', () => ({
  hostSupportsLaunchChoices: async () => false
}))
vi.mock('@/components/settings/use-host-agent-launch-preferences', () => ({
  ensureAgentLaunchPreferences: prep.preferences
}))
vi.mock('@/runtime/remote-agent-session-launch', () => ({
  runRemoteAgentSessionLaunch: async (args) => args.legacy()
}))
vi.mock('@/runtime/agent-session-keyboard-capability', () => ({
  createAgentSessionKeyboardOptions: () => async () => ({})
}))
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import { openDeclinedTerminal } from '@/lib/structured-agent-session-action-launch'
import { adoptAgentSessionLaunchVerdict } from '@/lib/agent-session-launch-plan'
import { canPresentDesktopNavigation } from '@/lib/desktop-navigation-request'
import { openNewThread } from '@/components/threads/thread-actions'
vi.mock('@/components/threads/thread-projects', async (original) => ({
  ...(await original<object>()),
  eligibleThreadProjects: async () => [{ key: 'newer-project' }]
}))

afterEach(() => resetTerminalCreateEnvironment())
it.each([
  { entry: 'paired', superseded: false },
  { entry: 'paired', superseded: true },
  { entry: 'declined', superseded: true }
])(
  '$entry terminal launch carries original request superseded=$superseded',
  async ({ entry, superseded }) => {
    stubTerminalCreateEnvironment(mocks)
    const state = mocks.getState()
    Object.assign(state, {
      activeView: 'terminal',
      activeWorkspaceExecutionHostId: RUNTIME_EXECUTION_HOST_ID,
      getActiveTab: () => null,
      getTab: () => null,
      setActiveTabType: vi.fn(),
      setActiveView: (view) => {
        state.activeView = view
      },
      repos: [],
      agentLaunchRecordsByTabId: {}
    })
    state.settings.experimentalThreads = true
    mocks.setActiveWorktree.mockImplementation((id, host) => {
      state.activeWorktreeId = id
      state.activeWorkspaceExecutionHostId = host
    })
    const held = Promise.withResolvers<{ agentLaunchChoices: Record<string, never> }>()
    prep.preferences.mockReturnValue(held.promise)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { tab: { id: 'paired-agent', leafId: 'leaf' } }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })
    const navigation = beginDesktopNavigation(state)
    const args = {
      agent: 'codex',
      worktreeId: WORKTREE_ID,
      prompt: 'copied fork context',
      promptDelivery: 'draft',
      navigation,
      agentSessionLaunchPlan: {
        route: 'terminal-tui',
        requestId: 'paired-fork',
        agent: 'codex',
        worktreeId: WORKTREE_ID
      }
    } as const
    const fallback =
      entry === 'declined'
        ? Promise.resolve(
            openDeclinedTerminal(
              {
                plan: adoptAgentSessionLaunchVerdict({
                  ...args.agentSessionLaunchPlan,
                  route: 'structured-native-chat',
                  prompt: args.prompt,
                  promptDelivery: 'draft'
                }),
                hooks: {},
                navigation
              },
              WORKTREE_ID,
              { kind: 'environment', environmentId: ENVIRONMENT_ID }
            )
          )
        : null
    const launched = fallback ? null : launchAgentInNewTab(args)
    if (launched) {
      expect(launched.surface.kind).toBe('host-published')
      await vi.waitFor(() => expect(prep.preferences).toHaveBeenCalledOnce())
    }
    if (superseded) {
      state.setActiveWorktree('repo::/newer', 'local')
      await openNewThread()
      expect(state.activeView).toBe('thread-draft')
    }
    expect(canPresentDesktopNavigation(navigation)).toBe(!superseded)
    await vi.waitFor(() => expect(prep.preferences).toHaveBeenCalledOnce())
    held.resolve({ agentLaunchChoices: {} })
    const outcome = await (fallback ? (await fallback).completion : launched?.terminalCompletion)
    expect(outcome?.outcome).toEqual(expect.objectContaining({ status: 'created' }))
    expect(outcome?.delivered).toBe(true)
    expect(state.activeView).toBe(superseded ? 'thread-draft' : 'terminal')
    expect(runtimeCall).toHaveBeenCalled()
    expect.soft(state.activeWorktreeId).toBe(superseded ? 'repo::/newer' : WORKTREE_ID)
    const owner = captureWebSessionIntentOwner(ENVIRONMENT_ID)
    expect
      .soft(peekWebSessionFocusIntent(owner, WORKTREE_ID)?.hostTabId ?? null)
      .toBe(superseded ? null : 'paired-agent')
  }
)
