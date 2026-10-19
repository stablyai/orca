import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TrackingDecisions from './web-session-tabs-sync/tracking-decisions'
import { closeWebRuntimeSessionTab } from './web-runtime-session-tab-lifecycle'
import {
  resetWebSessionCloseReplaysForTests,
  takeDueWebSessionCloseReplays
} from './web-session-close-replay'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'
import {
  isWebSessionCloseIntentPending,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
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
vi.mock('./web-session-tabs-sync/tracking-decisions', async (importOriginal) => ({
  ...(await importOriginal<typeof TrackingDecisions>()),
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot
}))
vi.mock('./web-session-tabs-sync/store-patch', () => ({
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    // The production caller invokes the returned settle receipt.
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

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  resetWebSessionCloseReplaysForTests()
})

const OWNER = { environmentId: ENVIRONMENT_ID }

async function closeAfter(failure: unknown, rejects = false): Promise<boolean> {
  const runtimeCall = vi.fn()
  if (rejects) {
    runtimeCall.mockRejectedValueOnce(failure)
  } else {
    runtimeCall.mockResolvedValueOnce(failure)
  }
  runtimeCall.mockResolvedValue({ id: 'close', ok: true, result: { closed: true } })
  stubRuntimeEnvironmentBridge({ call: runtimeCall })
  await expect(
    closeWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: 'local-browser-unified',
      reason: 'user'
    })
  ).resolves.toBe('failed')
  const held = isWebSessionCloseIntentPending(
    OWNER,
    WORKTREE_ID,
    'host-browser-unified',
    Date.now() + 60_000
  )
  const replayQueued =
    takeDueWebSessionCloseReplays(OWNER, WORKTREE_ID, new Set(['host-browser-unified'])).length > 0
  expect(replayQueued).toBe(held)
  return held
}

function envelope(code: string): unknown {
  return { id: 'close', ok: false, error: { code, message: 'failed' } }
}

// Pins which close failures keep the user's close for replay (round-2 S5), so a dropped code is deliberate.
describe('user close: which failures keep the intent', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      activeTabIdByWorktree: {},
      activeGroupIdByWorktree: {},
      setActiveWorktree: mocks.setActiveWorktree
    })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified' ? 'host-browser-unified' : null
    )
    // Store patches must run their updater so snapshot reconciliation is observable.
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      updater({
        state: 'before',
        activeWorktreeId: WORKTREE_ID
      })
    })
    mocks.applyWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
  })

  afterEach(() => {
    resetWebSessionFocusIntentForTests()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it.each([
    'runtime_manually_disconnected',
    'runtime_unavailable',
    'remote_runtime_unavailable',
    'runtime_timeout',
    'remote_runtime_timeout'
  ])('keeps the close when the answer is %s', async (code) => {
    expect(await closeAfter(envelope(code))).toBe(true)
  })

  // #30146: the web client mints this as a bare Error; it must never drop the close.
  it('keeps the close when the client itself refuses with runtime_manually_disconnected', async () => {
    expect(await closeAfter(new Error('runtime_manually_disconnected'), true)).toBe(true)
  })

  it('keeps the close on any thrown transport failure', async () => {
    expect(await closeAfter(new Error('socket hang up'), true)).toBe(true)
  })

  it.each([
    'invalid_argument',
    'runtime_rpc_queue_overloaded',
    'ssh_user_disconnected',
    'conflict'
  ])('drops the close when the answer is %s', async (code) => {
    expect(await closeAfter(envelope(code))).toBe(false)
  })
})
