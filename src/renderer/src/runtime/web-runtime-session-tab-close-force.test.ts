// A confirmed close of a pinned server tab carries `force` only to a host that advertises it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TrackingDecisions from './web-session-tabs-sync/tracking-decisions'
import {
  closeWebRuntimeSessionTab,
  replayWebSessionTabCloses
} from './web-runtime-session-tab-lifecycle'
import {
  resetWebSessionCloseReplaysForTests,
  takeDueWebSessionCloseReplays
} from './web-session-close-replay'
import { appPairedTerminalTabCloseIntentStore as INTENTS } from './paired-terminal-tab-close-intent-store'
import { createPairedTerminalTabCloseIntentTestStore } from '../store/terminals/paired-terminal-tab-close-intent.test-fixture'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import type * as RuntimeRpcClient from './runtime-rpc-client'
import type * as WebRuntimeSessionEnvironment from './web-runtime-session-environment'
import { ENVIRONMENT_ID, WORKTREE_ID, makeSnapshot } from './web-runtime-session-test-harness'
import '../../../shared/session-tabs-runtime-capabilities'
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
  hasMaterializedWebRuntimeBrowserPage: vi.fn(),
  runtimeEnvironmentSupportsCapability: vi.fn(),
  isWebRuntimeSessionActive: vi.fn()
}))

vi.mock('./web-runtime-session-environment', async (importOriginal) => ({
  ...(await importOriginal<typeof WebRuntimeSessionEnvironment>()),
  isWebRuntimeSessionActive: mocks.isWebRuntimeSessionActive
}))

vi.mock('./runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcClient>()),
  runtimeEnvironmentSupportsCapability: mocks.runtimeEnvironmentSupportsCapability
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
const HOST_TAB = 'host-browser-unified'

function closeCalls(runtimeCall: ReturnType<typeof vi.fn>): unknown[] {
  return runtimeCall.mock.calls.flatMap(([request]: unknown[]) =>
    typeof request === 'object' &&
    request !== null &&
    'method' in request &&
    request.method === 'session.tabs.close' &&
    'params' in request
      ? [request.params]
      : []
  )
}

function closeTab(force?: boolean) {
  return closeWebRuntimeSessionTab({
    worktreeId: WORKTREE_ID,
    tabId: 'local-browser-unified',
    reason: 'user',
    ...(force ? { force } : {})
  })
}

describe('a confirmed close of a pinned server tab', () => {
  beforeEach(() => {
    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const intents = createPairedTerminalTabCloseIntentTestStore()
    mocks.getState.mockImplementation(() => ({
      settings: { activeRuntimeEnvironmentId: ENVIRONMENT_ID },
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      activeTabIdByWorktree: {},
      activeGroupIdByWorktree: {},
      setActiveWorktree: mocks.setActiveWorktree,
      ...intents.getState()
    }))
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified' ? HOST_TAB : null
    )
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      updater({ state: 'before', activeWorktreeId: WORKTREE_ID })
    })
    mocks.applyWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
  })

  afterEach(() => {
    resetWebSessionFocusIntentForTests()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('keeps force on a held close the host never received, and sends it on replay', async () => {
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
    const runtimeCall = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ id: 'c', ok: true, result: { closed: true } })
      .mockResolvedValue({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(closeTab(true)).resolves.toBe('failed')
    const due = takeDueWebSessionCloseReplays(
      INTENTS,
      ENVIRONMENT_ID,
      WORKTREE_ID,
      new Set([HOST_TAB])
    )
    expect(due).toEqual([expect.objectContaining({ force: true })])
    await replayWebSessionTabCloses(ENVIRONMENT_ID, due)

    expect(closeCalls(runtimeCall)).toEqual([
      expect.objectContaining({ force: true }),
      expect.objectContaining({ tabId: HOST_TAB, reason: 'replay', force: true })
    ])
  })

  it('keeps force on a close held while the session is inactive', async () => {
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
    mocks.isWebRuntimeSessionActive.mockReturnValue(false)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({ id: 'c', ok: true, result: { closed: true } })
      .mockResolvedValue({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: HOST_TAB,
        environmentId: ENVIRONMENT_ID,
        reason: 'user',
        force: true
      })
    ).resolves.toBe('failed')
    expect(closeCalls(runtimeCall)).toEqual([])
    const due = takeDueWebSessionCloseReplays(
      INTENTS,
      ENVIRONMENT_ID,
      WORKTREE_ID,
      new Set([HOST_TAB])
    )
    expect(due).toEqual([expect.objectContaining({ force: true })])

    mocks.isWebRuntimeSessionActive.mockReturnValue(true)
    await replayWebSessionTabCloses(ENVIRONMENT_ID, due)
    expect(closeCalls(runtimeCall)).toEqual([
      expect.objectContaining({ tabId: HOST_TAB, reason: 'replay', force: true })
    ])
  })
})
