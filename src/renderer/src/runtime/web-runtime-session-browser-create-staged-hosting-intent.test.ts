import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostPlacementPreference } from '../../../shared/browser-client-host-placement'
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
  stubBrowserTabCreateEnvironment
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
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
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
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration,
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    // The production caller invokes the returned settle receipt.
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

const CREATE_GROUP_ID = 'client-group-create'
const SPLIT_GROUP_ID = 'client-group-split'
const STAGED_WORKSPACE_ID = 'staged-workspace-1'

const CLIENT_HOSTING_CAPABILITIES = [
  BROWSER_SCREENCAST_RUNTIME_CAPABILITY,
  BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
]

type HarnessState = Record<string, unknown>

/** The runtime status the create reads its capabilities and device scope from. */
function statusMap(options: {
  capabilities: string[]
  deviceScope?: string
}): Map<string, unknown> {
  return new Map([
    [
      ENVIRONMENT_ID,
      {
        status: {
          capabilities: options.capabilities,
          ...(options.deviceScope !== undefined ? { deviceScope: options.deviceScope } : {})
        },
        checkedAt: 1
      }
    ]
  ])
}

/**
 * Runs a create to completion against a client-hosting-capable runtime, letting each case bend one
 * input, and hands back the handle staging wrote — the frame the pane picks its component from.
 */
async function stageHandleFor(
  options: {
    capabilities?: string[]
    deviceScope?: string
    clientHostedSetting?: boolean
    placementPreference?: BrowserClientHostPlacementPreference
    onCreateCall?: (state: HarnessState) => void
  } = {}
): Promise<Record<string, unknown>> {
  const state = mocks.getState() as HarnessState
  state.runtimeStatusByEnvironmentId = statusMap({
    capabilities: options.capabilities ?? CLIENT_HOSTING_CAPABILITIES,
    ...(options.deviceScope !== undefined ? { deviceScope: options.deviceScope } : {})
  })
  state.settings = {
    ...(state.settings as Record<string, unknown>),
    ...(options.clientHostedSetting !== undefined
      ? { browserClientHostedRemoteEnabled: options.clientHostedSetting }
      : {})
  }

  const runtimeCall = vi.fn().mockImplementation(async (request: { method: string }) => {
    if (request.method === 'browser.tabCreate') {
      options.onCreateCall?.(state)
      return { id: 'create', ok: true, result: { browserPageId: 'remote-browser-page-1' } }
    }
    return { id: 'list', ok: true, result: makeSnapshot() }
  })
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        prepareBrowserClientHostPlacement: vi
          .fn()
          .mockResolvedValue({ kind: 'client', browserHostClientId: 'browser-client-a' }),
        call: runtimeCall
      }
    }
  })

  await createWebRuntimeSessionBrowserTab({
    worktreeId: WORKTREE_ID,
    clientTargetGroupId: CREATE_GROUP_ID,
    ...(options.placementPreference !== undefined
      ? { placementPreference: options.placementPreference }
      : {})
  })

  return mocks.setRemoteBrowserPageHandle.mock.calls[0]?.[1] as Record<string, unknown>
}

describe('staged client-hosting intent', () => {
  beforeEach(() => stubBrowserTabCreateEnvironment(mocks))
  afterEach(() => resetBrowserTabCreateEnvironment())

  it('marks the staged handle client-hosted when the create will be', async () => {
    // Without this flag the staged frame mounts the streamed pane and adoption swaps components —
    // the remount this whole design exists to remove.
    expect(await stageHandleFor()).toMatchObject({ staged: true, stagedClientHosted: true })
  })

  // Why: without browser.tab-create-known-id.v1 the create rehomes onto the host's page id, which
  // rewrites the handle. A rewrite that forgets the mark drops the pane back to streamed mid-create.
  it('keeps the client-hosted mark when the create rehomes onto a host-minted id', async () => {
    await stageHandleFor({
      capabilities: CLIENT_HOSTING_CAPABILITIES.filter(
        (capability) => capability !== BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY
      )
    })

    expect(mocks.setRemoteBrowserPageHandle.mock.calls.at(-1)?.[1]).toMatchObject({
      remotePageId: 'remote-browser-page-1',
      staged: true,
      stagedClientHosted: true
    })
  })

  it.each([
    {
      name: 'the caller asked for a server page',
      options: { placementPreference: 'server' as const }
    },
    {
      name: 'the host does not advertise client hosting',
      options: {
        capabilities: CLIENT_HOSTING_CAPABILITIES.filter(
          (capability) => capability !== BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY
        )
      }
    },
    { name: 'the user turned client hosting off', options: { clientHostedSetting: false } },
    { name: 'the runtime is a mobile device', options: { deviceScope: 'mobile' } }
  ])('leaves the staged handle server-hosted when $name', async ({ options }) => {
    const handle = await stageHandleFor(options)

    expect(handle).toMatchObject({ staged: true })
    expect(handle.stagedClientHosted).toBeUndefined()
  })
})

describe('materialization wait group', () => {
  beforeEach(() => stubBrowserTabCreateEnvironment(mocks))
  afterEach(() => resetBrowserTabCreateEnvironment())

  /** Group ids the create asked `hasMaterializedWebRuntimeBrowserPage` about. */
  function waitedGroupIds(): unknown[] {
    return mocks.hasMaterializedWebRuntimeBrowserPage.mock.calls.map((call) => call[4])
  }

  it('waits in the group the user dragged the staged tab into', async () => {
    await stageHandleFor({
      onCreateCall: (state) => {
        // The user splits the staged tab off while the create is still in flight.
        state.unifiedTabsByWorktree = {
          [WORKTREE_ID]: [
            {
              id: 'staged-unified-tab',
              entityId: STAGED_WORKSPACE_ID,
              contentType: 'browser',
              groupId: SPLIT_GROUP_ID
            }
          ]
        }
      }
    })

    // Waiting in CREATE_GROUP_ID would stall the create for the whole materialization window and
    // then log a "landed outside the requested group" that describes a group the user abandoned.
    expect(waitedGroupIds()).toContain(SPLIT_GROUP_ID)
    expect(waitedGroupIds()).not.toContain(CREATE_GROUP_ID)
  })

  it('falls back to the requested group while the staged tab is still there', async () => {
    await stageHandleFor()

    expect(waitedGroupIds()).toContain(CREATE_GROUP_ID)
  })
})
