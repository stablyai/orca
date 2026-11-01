import { afterEach, describe, expect, it, vi } from 'vitest'
import { setWebRuntimeTabProps } from './web-runtime-terminal-actions'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import { ENVIRONMENT_ID, WORKTREE_ID } from './web-runtime-session-test-harness'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

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
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
  acceptReplayedWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('./web-session-tabs-sync/tracking-lifecycle', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration
}))
vi.mock('./web-session-tabs-sync/snapshot-api', () => ({
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/tracking-decisions', () => ({
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/store-patch', () => ({
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    return () => {}
  }
}))
vi.mock('./web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

afterEach(() => resetWebSessionCloseIntentForTests())

const REPO_ID = 'repo'
type OwnerRow = { hostId: 'local' | `runtime:${string}`; runtimeOwnerEnvironmentId?: string }
const RUNTIME_ROW: OwnerRow = {
  hostId: `runtime:${ENVIRONMENT_ID}`,
  runtimeOwnerEnvironmentId: ENVIRONMENT_ID
}

function ownedBy(...rows: OwnerRow[]): Record<string, unknown> {
  return {
    repos: rows.map((row) => ({ id: REPO_ID, executionHostId: row.hostId })),
    worktreesByRepo: {
      [REPO_ID]: rows.map((row) => ({ id: WORKTREE_ID, repoId: REPO_ID, ...row }))
    }
  }
}

describe('setWebRuntimeTabProps', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('pushes pin to the host via session.tabs.setTabProps for a remote tab', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    mocks.getState.mockReturnValue(ownedBy(RUNTIME_ROW))
    const runtimeCall = vi.fn().mockResolvedValue({ id: 'p', ok: true, result: { updated: true } })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    expect(
      setWebRuntimeTabProps({
        worktreeId: WORKTREE_ID,
        tabId: 'web-terminal-host-tab-1',
        isPinned: true
      })
    ).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.setTabProps',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-tab-1',
        isPinned: true
      },
      timeoutMs: 15_000
    })
  })

  it('refuses a local twin of the paired server instead of pushing to either host', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    mocks.getState.mockReturnValue(ownedBy({ hostId: 'local' }, RUNTIME_ROW))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtimeCall = vi.fn()
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    expect(
      setWebRuntimeTabProps({ worktreeId: WORKTREE_ID, tabId: 'twin-tab', isPinned: true })
    ).toBe(false)
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]).toContain(WORKTREE_ID)
    warn.mockRestore()
  })

  it('does not push an unstamped row to the focused server', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    mocks.getState.mockReturnValue({
      settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
      runtimeEnvironments: [{ id: ENVIRONMENT_ID }],
      runtimeEnvironmentCatalogHydrated: true,
      repos: [{ id: REPO_ID }],
      worktreesByRepo: { [REPO_ID]: [{ id: WORKTREE_ID, repoId: REPO_ID }] }
    })
    const runtimeCall = vi.fn()
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    expect(
      setWebRuntimeTabProps({ worktreeId: WORKTREE_ID, tabId: 'local-tab', isPinned: true })
    ).toBe(false)
    expect(runtimeCall).not.toHaveBeenCalled()
  })
})
