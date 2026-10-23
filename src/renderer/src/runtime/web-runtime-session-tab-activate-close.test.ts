import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TrackingDecisions from './web-session-tabs-sync/tracking-decisions'
import {
  activateWebRuntimeSessionTab,
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
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import {
  isWebSessionCloseIntentPending,
  recordWebSessionCloseIntent,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import { WEB_SESSION_TAB_RPC_TIMEOUT_MS } from './web-session-tab-rpc-timeout'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import { ENVIRONMENT_ID, WORKTREE_ID, makeSnapshot } from './web-runtime-session-test-harness'
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
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('maps mirrored local browser unified ids for activate and close', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'activate',
        ok: true,
        result: {}
      })
      .mockResolvedValueOnce({
        id: 'close',
        ok: true,
        result: {}
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: makeSnapshot()
      })

    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(
      activateWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified'
      })
    ).resolves.toBe(true)
    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe('applied')

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.activate',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        notifyClients: false,
        navigation: 'caller',
        intent: 'user'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.close',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        reason: 'user'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(3, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.list',
      params: {
        worktree: `id:${WORKTREE_ID}`
      },
      timeoutMs: 15_000
    })
    expect(mocks.applyWebSessionTabsSnapshot).toHaveBeenCalled()
  })

  it('carries the picked split pane and the visible tab guard to the owner and focus intent', async () => {
    mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue('host-terminal')
    const runtimeCall = vi.fn().mockResolvedValue({ id: 'activate', ok: true, result: {} })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await activateWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: 'local-terminal',
      leafId: 'leaf-b',
      expectedCurrentLocalTabId: 'unified-local-terminal'
    })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'session.tabs.activate',
        params: expect.objectContaining({ tabId: 'host-terminal', leafId: 'leaf-b' })
      })
    )
    expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toEqual({
      hostTabId: 'host-terminal',
      leafId: 'leaf-b',
      expectedCurrentLocalTabId: 'unified-local-terminal'
    })
  })

  it('supersedes browser focus intent when a terminal is activated next', async () => {
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified' ? 'host-browser-unified' : 'host-terminal'
    )
    const runtimeCall = vi.fn().mockResolvedValue({ id: 'activate', ok: true, result: {} })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await activateWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: 'local-browser-unified'
    })
    await activateWebRuntimeSessionTab({ worktreeId: WORKTREE_ID, tabId: 'local-terminal' })

    expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toEqual({
      hostTabId: 'host-terminal'
    })
  })

  it('sends lifecycle and explicit user close reasons on the wire', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({ id: 'close-1', ok: true, result: {} })
      .mockResolvedValueOnce({ id: 'list-1', ok: true, result: makeSnapshot() })
      .mockResolvedValueOnce({ id: 'close-2', ok: true, result: {} })
      .mockResolvedValueOnce({ id: 'list-2', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminalHandle: 'term-1'
      })
    ).resolves.toBe('applied')
    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe('applied')

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.closeLifecycle',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminal: 'term-1'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(3, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.close',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        reason: 'user'
      },
      timeoutMs: 15_000
    })
  })

  it('suppresses lifecycle closes when terminal-incarnation evidence is missing', async () => {
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'list',
      ok: true,
      result: makeSnapshot()
    })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'pty-exit'
      })
    ).resolves.toBe('failed')

    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.list' })
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
  })

  // Why this distinction is load-bearing: a close that reports 'unknown-tab' lets the client
  // finish a teardown the host cannot, and reporting it for an ordinary failure would tear down
  // tabs a reachable host still holds.
  // Note: 'selector_not_found' is a transient scan cache miss during worktree discovery, not
  // definitive absence proof, so it classifies as 'failed' and must not drop TTL eviction.
  it.each([
    ['tab_not_found', 'unknown-tab'],
    ['selector_not_found', 'failed'],
    ['terminal_tab_not_found', 'unknown-tab'],
    ['runtime_rpc_timeout', 'failed']
  ])('classifies a %s close refusal as %s', async (code, outcome) => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({ id: 'close', ok: false, error: { code, message: code } })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe(outcome)
  })

  // #9194: a host can answer tab_not_found and still keep republishing the surface. The close
  // intent is what hides the mirror, so letting it age out handed the user back a phantom pane
  // whose handle is already gone -- and closing it again just restarted the same TTL loop.
  // 'selector_not_found' is transient, so it does not become durable and its suppression expires.
  it.each([
    ['tab_not_found', true],
    ['selector_not_found', false],
    ['terminal_tab_not_found', true],
    ['runtime_rpc_timeout', false]
  ])('keeps a %s close suppressed past the close-intent TTL: %s', async (code, stillPending) => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({ id: 'close', ok: false, error: { code, message: code } })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await closeWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: 'local-browser-unified',
      reason: 'user'
    })

    const hostTabId = toHostSessionTabId('local-browser-unified')
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        hostTabId,
        Date.now() + 60_000
      )
    ).toBe(stillPending)
  })

  // #9194, slow host: the close RPC can answer `tab_not_found` at any point up to its own timeout,
  // and a host that still republishes the surface keeps querying the intent in the meantime. That
  // query is what evicts an expired entry, so a TTL under the RPC timeout leaves nothing for the
  // durable flip to reach and the pane the user closed comes back.
  it('keeps a tab_not_found close suppressed when the host answers slower than the old TTL', async () => {
    const startedAt = 1_700_000_000_000
    let clock = startedAt
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    const owner = { environmentId: ENVIRONMENT_ID }
    const hostTabIds = [toHostSessionTabId('local-browser-unified'), 'host-browser-unified']
    let pendingWhileHostRepublished: boolean[] = []
    try {
      const runtimeCall = vi
        .fn()
        .mockImplementationOnce(() => {
          clock = startedAt + WEB_SESSION_TAB_RPC_TIMEOUT_MS - 1
          pendingWhileHostRepublished = hostTabIds.map((hostTabId) =>
            isWebSessionCloseIntentPending(owner, WORKTREE_ID, hostTabId, clock)
          )
          return Promise.resolve({
            id: 'close',
            ok: false,
            error: { code: 'tab_not_found', message: 'tab_not_found' }
          })
        })
        .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
      stubRuntimeEnvironmentBridge({ call: runtimeCall })

      await expect(
        closeWebRuntimeSessionTab({
          worktreeId: WORKTREE_ID,
          tabId: 'local-browser-unified',
          reason: 'user'
        })
      ).resolves.toBe('unknown-tab')

      expect(pendingWhileHostRepublished).toEqual([true, true])
      expect(
        hostTabIds.map((hostTabId) =>
          isWebSessionCloseIntentPending(owner, WORKTREE_ID, hostTabId, clock + 60_000)
        )
      ).toEqual([true, true])
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('fails closed when reconnect routes a lifecycle close to an older host', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'close',
        ok: false,
        error: {
          code: 'method_not_found',
          message: 'Unknown method: session.tabs.closeLifecycle'
        }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminalHandle: 'term-1'
      })
    ).resolves.toBe('failed')

    expect(runtimeCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: 'session.tabs.closeLifecycle' })
    )
    expect(runtimeCall).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'session.tabs.close' })
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        'host-browser-unified',
        Date.now()
      )
    ).toBe(false)
  })

  it('restores reconciliation authority when the host refuses a lifecycle close', async () => {
    const authoritative = makeSnapshot()
    authoritative.snapshotVersion = 6
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'close',
        ok: true,
        result: { closed: true, refused: true, snapshotRepublished: true }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: authoritative })

    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminalHandle: 'term-1'
      })
    ).resolves.toBe('applied')

    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        'host-browser-unified',
        Date.now()
      )
    ).toBe(false)
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
    expect(mocks.acceptReplayedWebSessionTabsSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.applyWebSessionTabsSnapshot.mock.invocationCallOrder[0]!
    )
  })

  it('reports a republished stale-terminal refusal to the caller exactly like a real close', async () => {
    const callFor = (result: unknown) => {
      const runtimeCall = vi
        .fn()
        .mockResolvedValueOnce({ id: 'close', ok: true, result })
        .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
      stubRuntimeEnvironmentBridge({ call: runtimeCall })
      return closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminalHandle: 'term-1'
      })
    }

    const committed = await callFor({ closed: true })
    const refused = await callFor({
      closed: true,
      refused: true,
      refusalReason: 'stale-terminal',
      snapshotRepublished: true
    })

    // Why: this is the whole user-visible bug. The host kept the tab and said so,
    // but the refusal is dropped here — the caller gets the same 'applied' it gets
    // for a real close, so the tab vanishes and silently reappears with no error,
    // no toast and no retry. Any fix must make these two outcomes distinguishable.
    expect(refused).toBe('applied')
    expect(refused).toBe(committed)

    // The un-hide that makes the tab come back.
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledWith(
      ENVIRONMENT_ID,
      WORKTREE_ID
    )
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        'host-browser-unified',
        Date.now()
      )
    ).toBe(false)
  })

  it('keeps the close intent when a refused lifecycle close was not republished', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'close',
        ok: true,
        result: { closed: true, refused: true }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })

    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    recordWebSessionCloseIntent(
      { environmentId: ENVIRONMENT_ID },
      WORKTREE_ID,
      'other-host-tab',
      Date.now()
    )
    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'pty-exit',
        publicationEpoch: 'epoch-1',
        terminalHandle: 'term-1'
      })
    ).resolves.toBe('applied')

    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        'host-browser-unified',
        Date.now()
      )
    ).toBe(true)
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        'other-host-tab',
        Date.now()
      )
    ).toBe(true)
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).not.toHaveBeenCalled()
  })

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

  // #30130 made a host's Disconnect answer calls locally; a tab closed then came back on reconnect.
  it('holds a user close made while the host is disconnected', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'runtime.manualDisconnect',
        ok: false,
        error: {
          code: 'runtime_manually_disconnected',
          message: 'Runtime environment is manually disconnected.'
        }
      })
      .mockResolvedValue({ id: 'close', ok: true, result: { closed: true } })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })
    const owner = { environmentId: ENVIRONMENT_ID }

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe('failed')

    expect(
      isWebSessionCloseIntentPending(
        owner,
        WORKTREE_ID,
        'host-browser-unified',
        Date.now() + 60_000
      )
    ).toBe(true)
    expect(
      takeDueWebSessionCloseReplays(
        INTENTS,
        ENVIRONMENT_ID,
        WORKTREE_ID,
        new Set(['host-browser-unified'])
      ).map((replay) => replay.hostTabIds[0])
    ).toEqual(['host-browser-unified'])
  })

  it('re-lists the worktree after holding a close so an idle host still gets the first replay', async () => {
    vi.useFakeTimers()
    try {
      const runtimeCall = vi.fn().mockRejectedValue(new Error('socket hang up'))
      stubRuntimeEnvironmentBridge({ call: runtimeCall })

      await closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
      const callsAfterClose = runtimeCall.mock.calls.length
      await vi.advanceTimersByTimeAsync(5_000)

      expect(
        runtimeCall.mock.calls
          .slice(callsAfterClose)
          .some(
            ([request]: unknown[]) =>
              typeof request === 'object' &&
              request !== null &&
              'method' in request &&
              request.method === 'session.tabs.list'
          )
      ).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-lists the worktree after a failed replay so an idle host still gets the next attempt', async () => {
    vi.useFakeTimers()
    try {
      const runtimeCall = vi.fn().mockRejectedValue(new Error('socket hang up'))
      stubRuntimeEnvironmentBridge({ call: runtimeCall })
      const owner = { environmentId: ENVIRONMENT_ID }
      holdWebSessionCloseForReplay(INTENTS, owner, WORKTREE_ID, ['host-browser-unified'])

      await replayWebSessionTabCloses(
        ENVIRONMENT_ID,
        takeDueWebSessionCloseReplays(
          INTENTS,
          ENVIRONMENT_ID,
          WORKTREE_ID,
          new Set(['host-browser-unified'])
        )
      )
      const callsAfterReplay = runtimeCall.mock.calls.length
      await vi.advanceTimersByTimeAsync(5_000)

      const relisted = runtimeCall.mock.calls
        .slice(callsAfterReplay)
        .some(
          ([request]: unknown[]) =>
            typeof request === 'object' &&
            request !== null &&
            'method' in request &&
            request.method === 'session.tabs.list'
        )
      expect(relisted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
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

  it('does not hold a lifecycle close the host never received', async () => {
    stubRuntimeEnvironmentBridge({ call: vi.fn().mockRejectedValue(new Error('socket hang up')) })

    await closeWebRuntimeSessionTab({
      worktreeId: WORKTREE_ID,
      tabId: 'local-browser-unified',
      reason: 'cleanup',
      publicationEpoch: 'epoch-1',
      terminalHandle: 'term-1'
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

  it('clears an optimistic close intent when pairing CAS rejects the host call', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'close-rejected',
      ok: false,
      error: { code: 'conflict', message: 'runtime_environment_replaced' }
    })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        reason: 'user'
      })
    ).resolves.toBe('failed')

    expect(
      isWebSessionCloseIntentPending(
        { environmentId: ENVIRONMENT_ID },
        WORKTREE_ID,
        'host-browser-unified',
        Date.now()
      )
    ).toBe(false)
  })
})
