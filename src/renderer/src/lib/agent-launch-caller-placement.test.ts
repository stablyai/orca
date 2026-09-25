// Where each call site's tab lands, whether it takes the selection, and what telemetry the launch
// is stamped with. Placement never rides a launch wire — it is applied locally — so it has to be
// observed on the tab the funnel creates.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  callerProfileCases,
  type AgentLaunchCallerProfile
} from './agent-launch-caller-profiles-test-harness'
import {
  createdTabGroupId,
  createdTabOptions,
  createLaunchFunnelStore,
  queuedStartupPayload,
  resetLaunchFunnelStore
} from './agent-launch-funnel-test-harness'

const store = createLaunchFunnelStore()

vi.mock('@/store', () => ({ useAppStore: { getState: () => store } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))
vi.mock('@/lib/connection-context', () => ({ getConnectionIdFromState: () => null }))
vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))
vi.mock('@/runtime/web-runtime-session', () => ({ isWebRuntimeSessionActive: () => false }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'local',
  getRuntimeEnvironmentIdForWorktree: () => null
}))
vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => `kind:${agent}`
}))
vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn(async () => true) }))
vi.mock('@/lib/agent-ready-wait', () => ({
  waitForAgentReady: vi.fn(async () => ({ ready: true, reason: 'foreground-match' }))
}))
vi.mock('@/runtime/local-runtime-capabilities', () => ({
  readLocalRuntimeCapabilitiesOrUnknown: () => []
}))

const cases = callerProfileCases()

async function launch(profile: AgentLaunchCallerProfile) {
  const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')
  return launchAgentInNewTab({ ...profile.args })
}

describe('agent launch caller placement and telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLaunchFunnelStore(store)
  })

  it.each(cases)('places the tab %s opens in the group it named', async (_id, profile) => {
    await launch(profile)

    // Why: an omitted group is not "the active group" at this layer — it is handed on as
    // `undefined` and the tab store decides, so the two shapes must stay distinguishable.
    expect(createdTabGroupId(store)).toBe(profile.args.groupId)
  })

  it.each(cases)('stamps the tab %s opens with its launch agent', async (_id, profile) => {
    await launch(profile)

    expect(createdTabOptions(store)).toMatchObject({ launchAgent: profile.args.agent })
  })

  // Why uniform: the store scopes activation to the launch's own workspace, so no caller — the
  // floating panel included — needs to opt out of the selection to protect the main window's.
  it.each(cases)('selects the tab %s opens within its own workspace', async (_id, profile) => {
    await launch(profile)

    expect(createdTabOptions(store)).not.toHaveProperty('activate')
    expect(store.setActiveTabType).toHaveBeenCalledExactlyOnceWith(
      'terminal',
      profile.args.worktreeId
    )
  })

  it.each(cases)('persists the tab-bar order after %s launches', async (_id, profile) => {
    await launch(profile)

    // Why: without this the stored order falls back to terminals-first and the new tab jumps to
    // index 0. It runs for every call site.
    expect(store.setTabBarOrder).toHaveBeenCalledTimes(1)
    expect(store.setTabBarOrder.mock.calls[0]?.[0]).toBe(profile.args.worktreeId)
    expect(store.setTabBarOrder.mock.calls[0]?.[1]).toContain('tab-1')
  })

  it.each(cases)(
    'labels the tab %s opens only when it is a quick command',
    async (_id, profile) => {
      await launch(profile)

      expect(createdTabOptions(store)?.quickCommandLabel).toBe(profile.args.quickCommandLabel)
    }
  )

  it.each(cases)(
    'queues the working directory %s named before the tab mounts',
    async (_id, profile) => {
      await launch(profile)

      if (profile.args.initialCwd) {
        expect(store.queueTabInitialCwd).toHaveBeenCalledExactlyOnceWith(
          'tab-1',
          profile.args.initialCwd
        )
        // Ordering matters: the pane snapshots the queued cwd on first render.
        expect(store.queueTabInitialCwd.mock.invocationCallOrder[0]).toBeLessThan(
          store.queueTabStartupCommand.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
        )
        return
      }
      expect(store.queueTabInitialCwd).not.toHaveBeenCalled()
    }
  )

  it.each(cases)('stamps the launch %s started with its telemetry source', async (_id, profile) => {
    await launch(profile)

    expect(queuedStartupPayload(store)?.telemetry).toEqual({
      agent_kind: `kind:${profile.args.agent}`,
      // git-history-explain-commit names no source, so it reports as a tab-bar quick launch.
      launch_source: profile.args.launchSource ?? 'tab_bar_quick_launch',
      request_kind: 'new'
    })
  })

  it('falls back to the tab-bar quick launch source when a caller names none', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    // Why: git-history-explain-commit is the one production call site that names no launch source,
    // so it is reported as a tab-bar quick launch rather than as its own surface.
    expect(queuedStartupPayload(store)?.telemetry).toEqual({
      agent_kind: 'kind:codex',
      launch_source: 'tab_bar_quick_launch',
      request_kind: 'new'
    })
  })

  it('creates the tab before queueing its startup command', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1' })

    // Why: the terminal pane snapshots pending startup in useState on first render, so a startup
    // queued after mount is never seen.
    expect(store.createTab.mock.invocationCallOrder[0]).toBeLessThan(
      store.queueTabStartupCommand.mock.invocationCallOrder[0] ?? 0
    )
  })

  it('seeds working status for a Command Code prompt that rides argv', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'command-code', worktreeId: 'wt-1', prompt: 'fix the spinner' })

    expect(queuedStartupPayload(store)?.initialAgentStatus).toEqual({
      agent: 'command-code',
      prompt: 'fix the spinner'
    })
  })

  it('leaves initial agent status unset for every other argv prompt launch', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({ agent: 'codex', worktreeId: 'wt-1', prompt: 'fix the spinner' })

    expect(queuedStartupPayload(store)).not.toHaveProperty('initialAgentStatus')
  })
})
