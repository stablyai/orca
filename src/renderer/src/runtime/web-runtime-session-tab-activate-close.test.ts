import { registerHistoricalSessionTabActivationTests } from './web-runtime-session-tab-historical-activation.spec'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TrackingDecisions from './web-session-tabs-sync/tracking-decisions'
import {
  closeWebRuntimeSessionTab,
  replayWebSessionTabCloses
} from './web-runtime-session-tab-lifecycle'
import {
  holdWebSessionCloseForReplay,
  resetWebSessionCloseReplaysForTests,
  takeDueWebSessionCloseReplays
} from './web-session-close-replay'
import { appPairedTerminalTabCloseIntentStore as INTENTS } from './paired-terminal-tab-close-intent-store'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { createPairedTerminalTabCloseIntentTestStore } from '../store/terminals/paired-terminal-tab-close-intent.test-fixture'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'
import {
  isWebSessionCloseIntentPending,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import './web-session-tab-rpc-timeout'
import '../../../shared/terminal-surface-id'
import { ENVIRONMENT_ID, WORKTREE_ID, makeSnapshot } from './web-runtime-session-test-harness'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  revealWorktree: vi.fn(() => true),
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

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.revealWorktree,
  activateAndRevealFolderWorkspace: mocks.revealWorktree
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

describe('web runtime session tab actions', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    const intents = createPairedTerminalTabCloseIntentTestStore()
    mocks.getState.mockImplementation(() => ({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      activeTabIdByWorktree: {},
      activeGroupIdByWorktree: {},
      setActiveWorktree: mocks.setActiveWorktree,
      ...intents.getState()
    }))
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
    replaceRuntimeEnvironmentRevisions([])
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  registerHistoricalSessionTabActivationTests(mocks, { ENVIRONMENT_ID, WORKTREE_ID })

  // STA-6224: clearing on a dropped connection let the host's next snapshot re-add the tab.
  it('holds a user close the host never received and sends it again once reachable', async () => {
    const runtimeCall = vi
      .fn()
      .mockRejectedValueOnce(new Error('socket hang up'))
      .mockResolvedValueOnce({ id: 'close', ok: true, result: { closed: true } })
      .mockResolvedValue({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })
    const owner = { environmentId: ENVIRONMENT_ID }

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe('failed')

    // Durable: a reconnect long after the RPC timeout must still not re-show it.
    expect(
      isWebSessionCloseIntentPending(
        owner,
        WORKTREE_ID,
        'host-browser-unified',
        Date.now() + 60_000
      )
    ).toBe(true)
    const due = takeDueWebSessionCloseReplays(
      INTENTS,
      ENVIRONMENT_ID,
      WORKTREE_ID,
      new Set(['host-browser-unified'])
    )
    expect(due.map((replay) => replay.hostTabIds[0])).toEqual(['host-browser-unified'])

    await replayWebSessionTabCloses(ENVIRONMENT_ID, due)

    const closeCalls = runtimeCall.mock.calls.filter(
      ([request]: unknown[]) =>
        typeof request === 'object' &&
        request !== null &&
        'method' in request &&
        request.method === 'session.tabs.close'
    )
    expect(closeCalls).toHaveLength(2)
    expect(closeCalls[1]?.[0]).toMatchObject({
      params: { tabId: 'host-browser-unified', reason: 'user' }
    })
    expect(
      takeDueWebSessionCloseReplays(
        INTENTS,
        ENVIRONMENT_ID,
        WORKTREE_ID,
        new Set(['host-browser-unified'])
      )
    ).toEqual([])
  })

  it('never replays a held close to an environment re-paired since', async () => {
    const runtimeCall = vi.fn()
    stubRuntimeEnvironmentBridge({ call: runtimeCall })
    replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 0, pairingRevision: 1 }])
    const owner = { environmentId: ENVIRONMENT_ID, pairingRevision: 1 }
    holdWebSessionCloseForReplay(INTENTS, owner, WORKTREE_ID, ['host-browser-unified'])
    const due = takeDueWebSessionCloseReplays(
      INTENTS,
      ENVIRONMENT_ID,
      WORKTREE_ID,
      new Set(['host-browser-unified'])
    )
    // Re-paired between the snapshot that made it due and the send.
    replaceRuntimeEnvironmentRevisions([{ id: ENVIRONMENT_ID, createdAt: 0, pairingRevision: 2 }])

    try {
      await replayWebSessionTabCloses(ENVIRONMENT_ID, due)
    } finally {
      replaceRuntimeEnvironmentRevisions([])
    }

    expect(due).toHaveLength(1)
    expect(runtimeCall).not.toHaveBeenCalled()
    expect(INTENTS.getIntents()?.[ENVIRONMENT_ID]).toBeUndefined()
  })
})
