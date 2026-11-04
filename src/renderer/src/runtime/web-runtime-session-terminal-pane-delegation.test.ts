import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { splitWebRuntimeTerminal } from './web-runtime-terminal-actions'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import { stubRuntimeEnvironmentBridge } from './runtime-environment-bridge-fixture'

const mocks = vi.hoisted(() => ({
  activateTabAndFocusPane: vi.fn(),
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

vi.mock('../lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: mocks.activateTabAndFocusPane
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

afterEach(() => {
  resetWebSessionCloseIntentForTests()
  resetWebSessionFocusIntentForTests()
  replaceRuntimeEnvironmentRevisions([])
})

const SPLIT_WORKTREE_ID = 'repo::/worktree'
const SPLIT_SOURCE = {
  worktreeId: SPLIT_WORKTREE_ID,
  tabId: toWebTerminalSurfaceTabId('tab-1'),
  leafId: 'leaf-1'
}

function makeSplitSourceState(
  hostTabId: string,
  leafId = 'leaf-1',
  activeHostTabId = hostTabId
): Record<string, unknown> {
  const tabId = toWebTerminalSurfaceTabId(hostTabId)
  const activeTabId = toWebTerminalSurfaceTabId(activeHostTabId)
  const tabs = [
    {
      id: tabId,
      worktreeId: SPLIT_WORKTREE_ID,
      contentType: 'terminal',
      ptyId: 'remote:web-env-1@@terminal-1'
    },
    ...(activeTabId === tabId
      ? []
      : [{ id: activeTabId, worktreeId: SPLIT_WORKTREE_ID, contentType: 'terminal' }])
  ]
  return {
    activeWorktreeId: SPLIT_WORKTREE_ID,
    activeWorkspaceExecutionHostId: 'runtime:web-env-1',
    activeTabType: 'terminal',
    activeTabTypeByWorktree: { [SPLIT_WORKTREE_ID]: 'terminal' },
    activeTabIdByWorktree: { [SPLIT_WORKTREE_ID]: activeTabId },
    tabsByWorktree: { [SPLIT_WORKTREE_ID]: tabs },
    unifiedTabsByWorktree: { [SPLIT_WORKTREE_ID]: tabs },
    groupsByWorktree: {},
    terminalLayoutsByTabId: {
      [tabId]: {
        activeLeafId: leafId,
        ptyIdsByLeafId: { [leafId]: 'remote:web-env-1@@terminal-1' }
      },
      ...(activeTabId === tabId ? {} : { [activeTabId]: { activeLeafId: 'active-leaf' } })
    }
  }
}

function stubSplitSourceTab(hostTabId: string): void {
  mocks.getState.mockReturnValue(makeSplitSourceState(hostTabId))
}

function makeSplitResult(leafId: string): unknown {
  return {
    id: leafId,
    ok: true,
    result: { split: { handle: leafId, tabId: 'tab-1', paneRuntimeId: -1, leafId } }
  }
}

describe('splitWebRuntimeTerminal', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('keeps the latest split focus intent when responses complete out of order', async () => {
    stubSplitSourceTab('tab-1')
    const splitResolvers: ((response: unknown) => void)[] = []
    let resolveList!: (response: unknown) => void
    const runtimeCall = vi.fn((request: { method: string }) => {
      if (request.method === 'terminal.split') {
        return new Promise((resolve) => splitResolvers.push(resolve))
      }
      return new Promise((resolve) => {
        resolveList = resolve
      })
    })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })
    const source = {
      worktreeId: SPLIT_WORKTREE_ID,
      tabId: toWebTerminalSurfaceTabId('tab-1'),
      leafId: 'leaf-1'
    }

    expect(
      splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'keyboard', source)
    ).toBe(true)
    expect(
      splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'keyboard', source)
    ).toBe(true)
    await vi.waitFor(() => expect(splitResolvers).toHaveLength(2))

    splitResolvers[1]?.(makeSplitResult('leaf-b'))
    await vi.waitFor(() =>
      expect(
        peekWebSessionFocusIntent({ environmentId: 'web-env-1' }, SPLIT_WORKTREE_ID)
      ).toMatchObject({ hostTabId: 'tab-1', leafId: 'leaf-b' })
    )

    splitResolvers[0]?.(makeSplitResult('leaf-a'))
    await Promise.resolve()
    await Promise.resolve()
    const intentAfterOlderCompletion = peekWebSessionFocusIntent(
      { environmentId: 'web-env-1' },
      SPLIT_WORKTREE_ID
    )

    resolveList({
      id: 'list',
      ok: true,
      result: {
        worktree: SPLIT_WORKTREE_ID,
        publicationEpoch: 'epoch-1',
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: 'terminal',
        tabs: []
      }
    })
    expect(intentAfterOlderCompletion).toMatchObject({ hostTabId: 'tab-1', leafId: 'leaf-b' })
    await vi.waitFor(() =>
      expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith(
        toWebTerminalSurfaceTabId('tab-1'),
        'leaf-b'
      )
    )
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalledWith(
      toWebTerminalSurfaceTabId('tab-1'),
      'leaf-a'
    )
  })

  it('lets a newer split with an unreconciled source supersede older focus', async () => {
    stubSplitSourceTab('tab-1')
    const splitResolvers: ((response: unknown) => void)[] = []
    const runtimeCall = vi.fn(() => new Promise((resolve) => splitResolvers.push(resolve)))
    stubRuntimeEnvironmentBridge({ call: runtimeCall })
    const split = (): boolean =>
      splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'keyboard', SPLIT_SOURCE)
    expect(split()).toBe(true)
    await vi.waitFor(() => expect(splitResolvers).toHaveLength(1))
    const staleSource = {
      worktreeId: SPLIT_WORKTREE_ID,
      tabId: toWebTerminalSurfaceTabId('tab-missing'),
      leafId: 'leaf-missing'
    }
    expect(
      splitWebRuntimeTerminal(
        'remote:web-env-1@@terminal-missing',
        'vertical',
        'keyboard',
        staleSource
      )
    ).toBe(true)
    await vi.waitFor(() => expect(splitResolvers).toHaveLength(2))
    splitResolvers[0]?.(makeSplitResult('leaf-a'))
    await vi.waitFor(() =>
      expect(
        peekWebSessionFocusIntent({ environmentId: 'web-env-1' }, SPLIT_WORKTREE_ID)
      ).toBeNull()
    )
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
    splitResolvers[1]?.(makeSplitResult('leaf-b'))
  })

  it('does not let an older snapshot completion clear or focus over a newer split', async () => {
    stubSplitSourceTab('tab-1')
    const splitResolvers: ((response: unknown) => void)[] = []
    let resolveList!: (response: unknown) => void
    const runtimeCall = vi.fn((request: { method: string }) => {
      if (request.method === 'terminal.split') {
        return new Promise((resolve) => splitResolvers.push(resolve))
      }
      return new Promise((resolve) => {
        resolveList = resolve
      })
    })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    expect(
      splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'keyboard', SPLIT_SOURCE)
    ).toBe(true)
    await vi.waitFor(() => expect(splitResolvers).toHaveLength(1))
    splitResolvers[0]?.({
      id: 'split-a',
      ok: true,
      result: {
        split: { handle: 'terminal-a', tabId: 'tab-1', paneRuntimeId: -1, leafId: 'leaf-a' }
      }
    })
    await vi.waitFor(() =>
      expect(
        peekWebSessionFocusIntent({ environmentId: 'web-env-1' }, SPLIT_WORKTREE_ID)
      ).toMatchObject({ leafId: 'leaf-a' })
    )

    expect(
      splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'keyboard', SPLIT_SOURCE)
    ).toBe(true)
    await vi.waitFor(() => expect(splitResolvers).toHaveLength(2))
    splitResolvers[1]?.({
      id: 'split-b',
      ok: true,
      result: {
        split: { handle: 'terminal-b', tabId: 'tab-1', paneRuntimeId: -1, leafId: 'leaf-b' }
      }
    })
    await vi.waitFor(() =>
      expect(
        peekWebSessionFocusIntent({ environmentId: 'web-env-1' }, SPLIT_WORKTREE_ID)
      ).toMatchObject({ leafId: 'leaf-b' })
    )

    resolveList({
      id: 'list',
      ok: true,
      result: {
        worktree: SPLIT_WORKTREE_ID,
        publicationEpoch: 'epoch-1',
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: 'terminal',
        tabs: []
      }
    })
    await vi.waitFor(() =>
      expect(mocks.activateTabAndFocusPane).toHaveBeenCalledWith(
        toWebTerminalSurfaceTabId('tab-1'),
        'leaf-b'
      )
    )
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalledWith(
      toWebTerminalSurfaceTabId('tab-1'),
      'leaf-a'
    )
  })

  it('does not steal focus after the viewer switches tabs while the host splits', async () => {
    stubSplitSourceTab('tab-1')
    let resolveSplit!: (response: unknown) => void
    const runtimeCall = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSplit = resolve
        })
    )
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    expect(
      splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'keyboard', SPLIT_SOURCE)
    ).toBe(true)
    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledOnce())
    mocks.getState.mockReturnValue(makeSplitSourceState('tab-2'))
    resolveSplit({
      id: 'split',
      ok: true,
      result: {
        split: {
          handle: 'terminal-2',
          tabId: 'tab-1',
          paneRuntimeId: -1,
          leafId: 'leaf-2'
        }
      }
    })

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledOnce())
    expect(peekWebSessionFocusIntent({ environmentId: 'web-env-1' }, SPLIT_WORKTREE_ID)).toBeNull()
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).not.toHaveBeenCalled()
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })

  it('drops a completed split intent after the environment re-pairs', async () => {
    stubSplitSourceTab('tab-1')
    replaceRuntimeEnvironmentRevisions([{ id: 'web-env-1', createdAt: 7 }])
    let resolveSplit!: (response: unknown) => void
    const runtimeCall = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveSplit = resolve
        })
    )
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    expect(
      splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'keyboard', SPLIT_SOURCE)
    ).toBe(true)
    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledOnce())
    replaceRuntimeEnvironmentRevisions([{ id: 'web-env-1', createdAt: 9 }])
    resolveSplit({
      id: 'split',
      ok: true,
      result: {
        split: {
          handle: 'terminal-2',
          tabId: 'tab-1',
          paneRuntimeId: -1,
          leafId: 'leaf-2'
        }
      }
    })

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledOnce())
    expect(
      peekWebSessionFocusIntent(
        { environmentId: 'web-env-1', pairingRevision: 9 },
        SPLIT_WORKTREE_ID
      )
    ).toBeNull()
    expect(mocks.acceptReplayedWebSessionTabsSnapshot).not.toHaveBeenCalled()
  })

  it('drops local focus when the environment re-pairs during snapshot replay', async () => {
    stubSplitSourceTab('tab-1')
    replaceRuntimeEnvironmentRevisions([{ id: 'web-env-1', createdAt: 7 }])
    let resolveList!: (response: unknown) => void
    const runtimeCall = vi.fn((request: { method: string }) =>
      request.method === 'terminal.split'
        ? Promise.resolve({
            id: 'split',
            ok: true,
            result: {
              split: {
                handle: 'terminal-2',
                tabId: 'tab-1',
                paneRuntimeId: -1,
                leafId: 'leaf-2'
              }
            }
          })
        : new Promise((resolve) => {
            resolveList = resolve
          })
    )
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    expect(
      splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'keyboard', SPLIT_SOURCE)
    ).toBe(true)
    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(2))
    replaceRuntimeEnvironmentRevisions([{ id: 'web-env-1', createdAt: 9 }])
    resolveList({
      id: 'list',
      ok: true,
      result: {
        worktree: SPLIT_WORKTREE_ID,
        publicationEpoch: 'epoch-1',
        snapshotVersion: 2,
        activeGroupId: null,
        activeTabId: null,
        activeTabType: 'terminal',
        tabs: []
      }
    })

    await vi.waitFor(() =>
      expect(
        peekWebSessionFocusIntent(
          { environmentId: 'web-env-1', pairingRevision: 7 },
          SPLIT_WORKTREE_ID
        )
      ).toBeNull()
    )
    expect(mocks.activateTabAndFocusPane).not.toHaveBeenCalled()
  })
})
