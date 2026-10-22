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
import {
  isWebSessionCloseIntentPending,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import type * as RuntimeRpcClient from './runtime-rpc-client'
import type * as WebRuntimeSessionEnvironment from './web-runtime-session-environment'
import { ENVIRONMENT_ID, WORKTREE_ID, makeSnapshot } from './web-runtime-session-test-harness'
import { SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY } from '../../../shared/session-tabs-runtime-capabilities'
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

  it('sends force to a host advertising the capability', async () => {
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({ id: 'c', ok: true, result: { closed: true } })
    runtimeCall.mockResolvedValue({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(closeTab(true)).resolves.toBe('applied')

    expect(mocks.runtimeEnvironmentSupportsCapability).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      SESSION_TAB_CLOSE_FORCE_RUNTIME_CAPABILITY
    )
    expect(closeCalls(runtimeCall)).toEqual([
      expect.objectContaining({ tabId: HOST_TAB, reason: 'user', force: true })
    ])
  })

  it('sends no force to an older host, which refuses and shows the tab again as today', async () => {
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(false)
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'c',
      ok: false,
      error: { code: 'terminal_tab_pinned', message: 'terminal_tab_pinned' }
    })
    runtimeCall.mockResolvedValue({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(closeTab(true)).resolves.toBe('failed')

    expect(closeCalls(runtimeCall)).toEqual([
      { worktree: expect.any(String), tabId: HOST_TAB, reason: 'user' }
    ])
    expect(isWebSessionCloseIntentPending(OWNER, WORKTREE_ID, HOST_TAB, Date.now())).toBe(false)
    expect(
      takeDueWebSessionCloseReplays(INTENTS, ENVIRONMENT_ID, WORKTREE_ID, new Set([HOST_TAB]))
    ).toEqual([])
  })

  it('never sends force or probes the host for an unconfirmed close', async () => {
    mocks.runtimeEnvironmentSupportsCapability.mockResolvedValue(true)
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({ id: 'c', ok: true, result: { closed: true } })
    runtimeCall.mockResolvedValue({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(closeTab()).resolves.toBe('applied')

    expect(mocks.runtimeEnvironmentSupportsCapability).not.toHaveBeenCalled()
    expect(closeCalls(runtimeCall)).toEqual([
      expect.not.objectContaining({ force: expect.anything() })
    ])
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
      expect.objectContaining({ tabId: HOST_TAB, reason: 'user', force: true })
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
      expect.objectContaining({ tabId: HOST_TAB, reason: 'user', force: true })
    ])
  })

  it('holds a close whose capability probe failed as undelivered, keeping its force', async () => {
    mocks.runtimeEnvironmentSupportsCapability.mockRejectedValueOnce(new Error('socket hang up'))
    const runtimeCall = vi.fn().mockResolvedValue({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(closeTab(true)).resolves.toBe('failed')

    expect(closeCalls(runtimeCall)).toEqual([])
    expect(isWebSessionCloseIntentPending(OWNER, WORKTREE_ID, HOST_TAB, Date.now() + 60_000)).toBe(
      true
    )
    expect(
      takeDueWebSessionCloseReplays(INTENTS, ENVIRONMENT_ID, WORKTREE_ID, new Set([HOST_TAB]))
    ).toEqual([expect.objectContaining({ force: true })])
  })
})
