import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateWebRuntimeSessionWorktree,
  refreshWebRuntimeSessionTabsSnapshot
} from './web-runtime-session'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import {
  confirmWebAgentSessionHandoffAfterCreate,
  isWebAgentSessionHandoffPostCreateSnapshotConfirmed,
  recordWebAgentSessionHandoff,
  resetWebAgentSessionHandoffsForTests
} from './web-agent-session-handoff'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import { ENVIRONMENT_ID, WORKTREE_ID, makeSnapshot } from './web-runtime-session-test-harness'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'

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
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn(),
  recoverWebSessionTerminalOrphansBeforeApply: vi.fn(
    async (_state: unknown, snapshot: unknown) => snapshot
  )
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

vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: mocks.recoverWebSessionTerminalOrphansBeforeApply
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

afterEach(() => resetWebSessionCloseIntentForTests())

describe('refreshWebRuntimeSessionTabsSnapshot', () => {
  afterEach(() => {
    resetWebAgentSessionHandoffsForTests()
    replaceRuntimeEnvironmentRevisions([])
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('confirms only the exact handoff after its post-create list completes', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'list',
      ok: true,
      result: makeSnapshot()
    })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) =>
      updater({ state: 'before' })
    )
    mocks.applyWebSessionTabsSnapshot.mockImplementation((state) => state)
    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a'
    })
    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-b',
      hostTabId: 'host-b',
      hostTerminalHandle: 'term_host-b'
    })

    await refreshWebRuntimeSessionTabsSnapshot(ENVIRONMENT_ID, WORKTREE_ID, {
      acceptCurrentSnapshot: true,
      confirmAgentSessionHandoff: {
        provisionalTabId: 'provisional-a',
        hostTabId: 'host-a',
        hostTerminalHandle: 'term_host-a'
      }
    })

    const confirmed = (provisionalTabId: string): boolean =>
      isWebAgentSessionHandoffPostCreateSnapshotConfirmed({
        environmentId: ENVIRONMENT_ID,
        worktreeId: WORKTREE_ID,
        provisionalTabId
      })
    expect(confirmed('provisional-a')).toBe(true)
    expect(confirmed('provisional-b')).toBe(false)
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )

    recordWebAgentSessionHandoff({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a-replacement'
    })
    confirmWebAgentSessionHandoffAfterCreate({
      environmentId: ENVIRONMENT_ID,
      worktreeId: WORKTREE_ID,
      provisionalTabId: 'provisional-a',
      hostTabId: 'host-a',
      hostTerminalHandle: 'term_host-a'
    })
    expect(confirmed('provisional-a')).toBe(false)
  })

  it('applies the recovered snapshot instead of a transient pending-handle frame', async () => {
    const pending = makeSnapshot()
    const recovered = { ...pending, publicationEpoch: 'recovered', snapshotVersion: 2 }
    const state = { state: 'before' }
    const runtimeCall = vi.fn().mockResolvedValue({ id: 'list', ok: true, result: pending })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })
    mocks.getState.mockReturnValue(state)
    mocks.setState.mockImplementation((updater: (current: unknown) => unknown) => updater(state))
    mocks.recoverWebSessionTerminalOrphansBeforeApply.mockResolvedValueOnce(recovered)
    mocks.applyWebSessionTabsSnapshot.mockImplementation((state) => state)
    replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 1, pairingRevision: 17 }])

    await refreshWebRuntimeSessionTabsSnapshot(ENVIRONMENT_ID, WORKTREE_ID)

    expect(mocks.recoverWebSessionTerminalOrphansBeforeApply).toHaveBeenCalledWith(
      state,
      pending,
      ENVIRONMENT_ID,
      {
        expectedEnvironmentPairingRevision: 17,
        getCurrentState: expect.any(Function)
      }
    )
    expect(mocks.applyWebSessionTabsSnapshot).toHaveBeenCalledWith(state, recovered, ENVIRONMENT_ID)
  })
})

describe('activateWebRuntimeSessionWorktree', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      }
    })
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) =>
      updater({ state: 'before' })
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearRuntimeCompatibilityCacheForTests()
    vi.clearAllMocks()
  })

  it('activates caller-owned session surfaces without steering host or clients', async () => {
    const snapshot = makeSnapshot()
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'activate',
        ok: true,
        result: { repoId: 'repo', worktreeId: WORKTREE_ID, activated: true }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: snapshot })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      activateWebRuntimeSessionWorktree({
        worktreeId: WORKTREE_ID
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'worktree.activate',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        notifyClients: false,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.list',
      params: { worktree: `id:${WORKTREE_ID}` },
      timeoutMs: 15_000
    })
    expect(mocks.applyWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before' },
      snapshot,
      ENVIRONMENT_ID
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
  })
})
