import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY
} from '../../../shared/protocol-version'
import { createWebRuntimeSessionBrowserTab } from './web-runtime-session'
import {
  ENVIRONMENT_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetBrowserTabCreateEnvironment,
  stubBrowserTabCreateEnvironment,
  webRuntimeSessionWindowApi
} from './web-runtime-session-test-harness'

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
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))
vi.mock('./web-session-tabs-sync', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot,
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    return () => {}
  },
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))
vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))
vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

const CLIENT_HOSTING_CAPABILITIES = [
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
]

/**
 * The capability list a client that connected before the runtime upgraded still has cached: the
 * pre-upgrade build advertised browser streaming but nothing client hosting needs.
 */
const PRE_UPGRADE_CAPABILITIES = [
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY
]

function cacheCapabilities(capabilities: string[]): void {
  const state = mocks.getState() as Record<string, unknown>
  state.runtimeStatusByEnvironmentId = new Map([
    [ENVIRONMENT_ID, { status: { capabilities }, checkedAt: 1 }]
  ])
}

function successfulCreateCalls(): ReturnType<typeof vi.fn> {
  return vi
    .fn()
    .mockResolvedValueOnce({
      id: 'create',
      ok: true,
      result: { browserPageId: 'remote-browser-page-1' }
    })
    .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
}

/** The last handle staging wrote — the frame the pane picks its component from. */
function lastStagedHandle(): Record<string, unknown> | undefined {
  return mocks.setRemoteBrowserPageHandle.mock.calls.at(-1)?.[1] as
    | Record<string, unknown>
    | undefined
}

describe('browser placement against a stale capability cache', () => {
  beforeEach(() => stubBrowserTabCreateEnvironment(mocks))
  afterEach(() => resetBrowserTabCreateEnvironment())

  it('consults the live placement check even when the cached catalog shows no client hosting', async () => {
    cacheCapabilities(PRE_UPGRADE_CAPABILITIES)
    const preparePlacement = vi
      .fn()
      .mockResolvedValue({ kind: 'client', browserHostClientId: 'browser-client-a' })
    const runtimeCall = successfulCreateCalls()
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall, preparePlacement))

    await expect(createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })).resolves.toBe(true)

    // Trusting the cache here pinned an upgraded pair to server placement for a whole catalog TTL.
    expect(preparePlacement).toHaveBeenCalledWith(
      expect.objectContaining({ selector: ENVIRONMENT_ID, preference: 'auto' })
    )
    expect(runtimeCall.mock.calls[0]?.[0].params).toMatchObject({
      placement: { kind: 'client', browserHostClientId: 'browser-client-a' }
    })
  })

  it('re-marks the staged pane client-hosted once the live placement outvotes the cache', async () => {
    cacheCapabilities(PRE_UPGRADE_CAPABILITIES)
    const preparePlacement = vi
      .fn()
      .mockResolvedValue({ kind: 'client', browserHostClientId: 'browser-client-a' })
    const runtimeCall = successfulCreateCalls()
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall, preparePlacement))

    await createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })

    // The staged frame is minted from the cache, so without the re-mark the pane mounts the
    // streamed component and swaps only once adoption lands.
    expect(lastStagedHandle()).toMatchObject({ staged: true, stagedClientHosted: true })
    // The rewrite must keep addressing the page the create actually asked the host for; a handle
    // pointing anywhere else describes a page nothing will ever adopt. Matched against every write
    // rather than the last, because adoption rewrites the handle again with the host's own id.
    expect(mocks.setRemoteBrowserPageHandle.mock.calls.map((call) => call[1])).toContainEqual({
      environmentId: ENVIRONMENT_ID,
      remotePageId: runtimeCall.mock.calls[0]?.[0].params.page,
      staged: true,
      stagedClientHosted: true
    })
  })

  it('clears the staged client-hosted mark when the live placement answers server', async () => {
    cacheCapabilities(CLIENT_HOSTING_CAPABILITIES)
    const preparePlacement = vi.fn().mockResolvedValue({ kind: 'server' })
    vi.stubGlobal('window', webRuntimeSessionWindowApi(successfulCreateCalls(), preparePlacement))

    await createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })

    expect(lastStagedHandle()).toMatchObject({ staged: true })
    expect(lastStagedHandle()?.stagedClientHosted).toBeUndefined()
  })

  it('keeps the create server-side when the live check refuses an incapable runtime', async () => {
    cacheCapabilities(PRE_UPGRADE_CAPABILITIES)
    const preparePlacement = vi.fn().mockResolvedValue({ kind: 'server' })
    const runtimeCall = successfulCreateCalls()
    vi.stubGlobal('window', webRuntimeSessionWindowApi(runtimeCall, preparePlacement))

    await expect(createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID })).resolves.toBe(true)

    expect(preparePlacement).toHaveBeenCalledOnce()
    expect(runtimeCall.mock.calls[0]?.[0].params).not.toHaveProperty('placement')
  })

  it('still skips the placement check for an explicit server request', async () => {
    cacheCapabilities(PRE_UPGRADE_CAPABILITIES)
    const preparePlacement = vi.fn()
    vi.stubGlobal('window', webRuntimeSessionWindowApi(successfulCreateCalls(), preparePlacement))

    await expect(
      createWebRuntimeSessionBrowserTab({ worktreeId: WORKTREE_ID, placementPreference: 'server' })
    ).resolves.toBe(true)

    expect(preparePlacement).not.toHaveBeenCalled()
  })
})
