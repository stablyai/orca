/* eslint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  activateWebRuntimeSessionTab,
  closeWebRuntimeTerminal,
  closeWebRuntimeSessionTab,
  consumePendingWebRuntimeSplitMirrorTelemetry,
  createWebRuntimeSessionBrowserTab,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive,
  moveWebRuntimeSessionTab,
  setWebRuntimeTabProps,
  splitWebRuntimeTerminal
} from './web-runtime-session'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  setActiveWorktree: vi.fn(),
  createBrowserTab: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyFreshWebSessionTabsSnapshot: vi.fn(),
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  applyFreshWebSessionTabsSnapshot: mocks.applyFreshWebSessionTabsSnapshot,
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: mocks.getRuntimeEnvironmentIdForWorktree
}))

const ENVIRONMENT_ID = 'web-env-1'
const WORKTREE_ID = 'repo::/worktree'

function makeSnapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: null,
    activeTabType: null,
    tabs: []
  }
}

describe('createWebRuntimeSessionBrowserTab', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      activeWorktreeId: WORKTREE_ID,
      browserPagesByWorkspace: {},
      remoteBrowserPageHandlesByPageId: {},
      createBrowserTab: mocks.createBrowserTab,
      setRemoteBrowserPageHandle: mocks.setRemoteBrowserPageHandle,
      focusBrowserTabInWorktree: mocks.focusBrowserTabInWorktree,
      setActiveWorktree: mocks.setActiveWorktree
    })
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      updater({
        state: 'before',
        activeWorktreeId: WORKTREE_ID
      })
    })
    mocks.createBrowserTab.mockReturnValue({
      id: 'local-browser-workspace-1',
      activePageId: 'local-page-1',
      pageIds: ['local-page-1']
    })
    mocks.applyFreshWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('eagerly applies the host session snapshot after creating a remote browser tab', async () => {
    const snapshot = makeSnapshot()
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: snapshot
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        url: 'https://example.com/'
      })
    ).resolves.toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledTimes(1))

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'browser.tabCreate',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        url: 'https://example.com/',
        profileId: undefined,
        // Why: a user-initiated "New Browser Tab" focuses the new tab, which on a
        // headless host marks it active in the session snapshot.
        activate: true,
        waitForRegistration: false
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.list',
      params: {
        worktree: `id:${WORKTREE_ID}`
      },
      timeoutMs: 15_000
    })
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before', activeWorktreeId: WORKTREE_ID },
      snapshot,
      ENVIRONMENT_ID
    )
    expect(mocks.createBrowserTab).toHaveBeenCalledWith(WORKTREE_ID, 'https://example.com/', {
      title: 'https://example.com/',
      focusAddressBar: true,
      browserRuntimeEnvironmentId: ENVIRONMENT_ID
    })
    expect(mocks.setRemoteBrowserPageHandle).toHaveBeenCalledWith('local-page-1', {
      environmentId: ENVIRONMENT_ID,
      remotePageId: 'remote-browser-page-1'
    })
  })

  it('keeps the requested worktree selected while the browser snapshot catches up', async () => {
    const snapshot = makeSnapshot()
    const setStateResults: unknown[] = []
    let mockState: Record<string, unknown> = { state: 'before-stage', activeWorktreeId: 'landing' }
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      const result = updater(mockState)
      setStateResults.push(result)
      if (result && result !== mockState) {
        mockState = { ...mockState, ...(result as Record<string, unknown>) }
      }
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockImplementationOnce(async () => {
        mockState = { ...mockState, activeWorktreeId: 'other-worktree' }
        return {
          id: 'list',
          ok: true,
          result: snapshot
        }
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        url: 'https://example.com/'
      })
    ).resolves.toBe(true)

    await vi.waitFor(() => expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledTimes(1))

    expect(mocks.setActiveWorktree).toHaveBeenCalledWith(WORKTREE_ID)
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before-stage', activeWorktreeId: 'other-worktree' },
      snapshot,
      ENVIRONMENT_ID
    )
    expect(setStateResults.at(-1)).toEqual({ state: 'after' })
  })

  it('can create a browser tab without selecting the target worktree', async () => {
    const setStateResults: unknown[] = []
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      const result = updater({
        state: 'before-stage',
        activeWorktreeId: 'main-worktree'
      })
      setStateResults.push(result)
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: makeSnapshot()
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        url: 'https://example.com/',
        selectWorktree: false
      })
    ).resolves.toBe(true)

    expect(mocks.setActiveWorktree).not.toHaveBeenCalled()
    expect(mocks.focusBrowserTabInWorktree).not.toHaveBeenCalled()
  })

  it('does not focus a staged browser tab when the user leaves before host create resolves', async () => {
    let activeWorktreeId = WORKTREE_ID
    mocks.getState.mockImplementation(() => ({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      activeWorktreeId,
      browserPagesByWorkspace: {},
      remoteBrowserPageHandlesByPageId: {},
      createBrowserTab: mocks.createBrowserTab,
      setRemoteBrowserPageHandle: mocks.setRemoteBrowserPageHandle,
      focusBrowserTabInWorktree: mocks.focusBrowserTabInWorktree,
      setActiveWorktree: mocks.setActiveWorktree
    }))
    const runtimeCall = vi
      .fn()
      .mockImplementationOnce(async () => {
        activeWorktreeId = 'other-worktree'
        return {
          id: 'create',
          ok: true,
          result: { browserPageId: 'remote-browser-page-1' }
        }
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: makeSnapshot()
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        url: 'https://example.com/'
      })
    ).resolves.toBe(true)

    expect(mocks.focusBrowserTabInWorktree).not.toHaveBeenCalled()
    expect(mocks.setActiveWorktree).toHaveBeenCalledWith(WORKTREE_ID)
    await vi.waitFor(() => expect(mocks.setState).toHaveBeenCalledTimes(1))
  })

  it('does not require a staged browser page before the host snapshot catches up', async () => {
    mocks.createBrowserTab.mockReturnValue({
      id: 'local-browser-workspace-1'
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { browserPageId: 'remote-browser-page-1' }
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: makeSnapshot()
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      createWebRuntimeSessionBrowserTab({
        worktreeId: WORKTREE_ID,
        url: 'https://example.com/'
      })
    ).resolves.toBe(true)

    await vi.waitFor(() => expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledTimes(1))
    expect(mocks.setRemoteBrowserPageHandle).not.toHaveBeenCalled()
  })
})

describe('createWebRuntimeSessionTerminal', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      activeWorktreeId: WORKTREE_ID,
      browserPagesByWorkspace: {},
      remoteBrowserPageHandlesByPageId: {},
      createBrowserTab: mocks.createBrowserTab,
      setRemoteBrowserPageHandle: mocks.setRemoteBrowserPageHandle,
      focusBrowserTabInWorktree: mocks.focusBrowserTabInWorktree,
      setActiveWorktree: mocks.setActiveWorktree
    })
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      updater({
        state: 'before',
        activeWorktreeId: WORKTREE_ID
      })
    })
    mocks.applyFreshWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockReturnValue(null)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('creates paired web terminals through session tabs so host activation is mirrored', async () => {
    const snapshot = {
      ...makeSnapshot(),
      snapshotVersion: 2,
      activeTabId: 'host-tab-2::leaf-1',
      activeTabType: 'terminal' as const,
      tabs: [
        {
          type: 'terminal' as const,
          id: 'host-tab-2::leaf-1',
          parentTabId: 'host-tab-2',
          leafId: 'leaf-1',
          title: 'Terminal 2',
          terminal: 'pty-2',
          status: 'ready' as const,
          isActive: true
        }
      ]
    }
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create-terminal',
        ok: true,
        result: {
          tab: snapshot.tabs[0],
          publicationEpoch: snapshot.publicationEpoch,
          snapshotVersion: snapshot.snapshotVersion
        }
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: snapshot
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        afterTabId: 'web-terminal-host-tab-1%3A%3Aleaf-1',
        targetGroupId: 'group-left',
        command: "codex 'linked issue context'",
        env: { CODEX_PROFILE: 'captured' },
        startupCommandDelivery: 'shell-ready',
        launchConfig: {
          agentArgs: '--model gpt-5',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        launchAgent: 'codex',
        activate: true
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.createTerminal',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        afterTabId: 'host-tab-1::leaf-1',
        targetGroupId: 'group-left',
        command: "codex 'linked issue context'",
        env: { CODEX_PROFILE: 'captured' },
        startupCommandDelivery: 'shell-ready',
        launchConfig: {
          agentArgs: '--model gpt-5',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        launchAgent: 'codex',
        activate: true
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.list',
      params: {
        worktree: `id:${WORKTREE_ID}`
      },
      timeoutMs: 15_000
    })
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before', activeWorktreeId: WORKTREE_ID },
      snapshot,
      ENVIRONMENT_ID
    )
  })

  it('can create a terminal without selecting the target worktree', async () => {
    const setStateResults: unknown[] = []
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      const result = updater({
        state: 'before',
        activeWorktreeId: 'main-worktree'
      })
      setStateResults.push(result)
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create-terminal',
        ok: true,
        result: {
          tab: {
            type: 'terminal',
            id: 'host-tab-2::leaf-1',
            parentTabId: 'host-tab-2',
            leafId: 'leaf-1',
            title: 'Terminal 2',
            terminal: 'pty-2',
            status: 'ready',
            isActive: true
          },
          publicationEpoch: 'epoch-1',
          snapshotVersion: 2
        }
      })
      .mockResolvedValueOnce({
        id: 'list',
        ok: true,
        result: makeSnapshot()
      })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        activate: true,
        selectWorktree: false
      })
    ).resolves.toBe(true)

    expect(setStateResults).not.toContainEqual({ activeWorktreeId: WORKTREE_ID })
  })
})

describe('moveWebRuntimeSessionTab', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      setActiveWorktree: mocks.setActiveWorktree
    })
    mocks.applyFreshWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('moves paired web tabs through the host session API without an eager stale refresh', async () => {
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'web-terminal-host-tab-1%3A%3Aleaf-1',
        targetGroupId: 'group-right',
        kind: 'split',
        splitDirection: 'right'
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-tab-1::leaf-1',
        targetGroupId: 'group-right',
        kind: 'split',
        splitDirection: 'right'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(mocks.applyFreshWebSessionTabsSnapshot).not.toHaveBeenCalled()
  })

  it('maps mirrored local browser unified ids back to host session tab ids', async () => {
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified'
          ? 'host-browser-unified'
          : args.tabId === 'local-terminal-unified'
            ? 'host-terminal'
            : null
    )
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        targetGroupId: 'group-right',
        kind: 'reorder',
        tabOrder: ['local-terminal-unified', 'local-only-unified', 'local-browser-unified']
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        targetGroupId: 'group-right',
        kind: 'reorder',
        tabOrder: ['host-terminal', 'host-browser-unified']
      },
      timeoutMs: 15_000
    })
  })

  it('counts only host-backed tabs for mirrored move-to-group indexes', async () => {
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      setActiveWorktree: mocks.setActiveWorktree,
      groupsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'group-right',
            activeTabId: 'local-only-unified',
            tabOrder: ['local-only-unified', 'local-terminal-unified']
          }
        ]
      }
    })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified'
          ? 'host-browser-unified'
          : args.tabId === 'local-terminal-unified'
            ? 'host-terminal'
            : null
    )
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        targetGroupId: 'group-right',
        kind: 'move-to-group',
        index: 1
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        targetGroupId: 'group-right',
        kind: 'move-to-group',
        index: 0
      },
      timeoutMs: 15_000
    })
  })

  it('does not mirror a reorder when the dragged tab is local-only', async () => {
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-terminal-unified' ? 'host-terminal' : null
    )
    const runtimeCall = vi.fn().mockResolvedValueOnce({
      id: 'move',
      ok: true,
      result: { moved: true }
    })

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      moveWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-only-unified',
        targetGroupId: 'group-right',
        kind: 'reorder',
        tabOrder: ['local-only-unified', 'local-terminal-unified']
      })
    ).resolves.toBe(false)

    expect(runtimeCall).not.toHaveBeenCalled()
  })
})

describe('web runtime session tab actions', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.getState.mockReturnValue({
      settings: {
        activeRuntimeEnvironmentId: ENVIRONMENT_ID
      },
      setActiveWorktree: mocks.setActiveWorktree
    })
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified' ? 'host-browser-unified' : null
    )
  })

  afterEach(() => {
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

    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    await expect(
      activateWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified'
      })
    ).resolves.toBe(true)
    await expect(
      closeWebRuntimeSessionTab({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified'
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.activate',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.close',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified'
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
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalled()
  })
})

describe('splitWebRuntimeTerminal', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('passes telemetry source to the host split while allowing the mirrored split event to be suppressed', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'split',
      ok: true,
      result: {
        split: {
          handle: 'terminal-2',
          tabId: 'tab-1',
          paneRuntimeId: -1
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'horizontal', 'keyboard')).toBe(
      true
    )
    expect(
      consumePendingWebRuntimeSplitMirrorTelemetry('remote:web-env-1@@terminal-other', 'horizontal')
    ).toBe(false)
    expect(
      consumePendingWebRuntimeSplitMirrorTelemetry('remote:web-env-1@@terminal-1', 'horizontal')
    ).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'web-env-1',
      method: 'terminal.split',
      params: {
        terminal: 'terminal-1',
        direction: 'horizontal',
        telemetrySource: 'keyboard'
      },
      timeoutMs: 15_000
    })
  })

  it('does not track rejected host split RPCs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'split',
      ok: false,
      error: { code: 'terminal_exited', message: 'Terminal exited' }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(
      splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'vertical', 'context_menu')
    ).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalledTimes(1))
    expect(mocks.trackTerminalPaneSplit).not.toHaveBeenCalled()
  })

  it('ignores local panes but delegates remote runtime panes from desktop or web clients', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'split',
      ok: true,
      result: {
        split: {
          handle: 'terminal-2',
          tabId: 'tab-1',
          ptyId: 'pty-2'
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(splitWebRuntimeTerminal('pty-local-1', 'horizontal', 'keyboard')).toBe(false)
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    expect(splitWebRuntimeTerminal('remote:web-env-1@@terminal-1', 'horizontal', 'keyboard')).toBe(
      true
    )

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
  })
})

describe('closeWebRuntimeTerminal', () => {
  beforeEach(() => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('delegates remote pane close to the host runtime', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'close',
      ok: true,
      result: {
        close: {
          handle: 'terminal-1',
          tabId: 'tab-1',
          ptyKilled: true
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(closeWebRuntimeTerminal('remote:web-env-1@@terminal-1')).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: 'web-env-1',
      method: 'terminal.close',
      params: {
        terminal: 'terminal-1'
      },
      timeoutMs: 15_000
    })
  })

  it('ignores local panes but delegates remote runtime panes from desktop or web clients', async () => {
    const runtimeCall = vi.fn().mockResolvedValue({
      id: 'close',
      ok: true,
      result: {
        close: {
          handle: 'terminal-1',
          tabId: 'tab-1',
          ptyKilled: true
        }
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeCall
        }
      }
    })

    expect(closeWebRuntimeTerminal('pty-local-1')).toBe(false)
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    expect(closeWebRuntimeTerminal('remote:web-env-1@@terminal-1')).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
  })

  it('treats any configured remote runtime environment as a shared session', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)

    expect(isWebRuntimeSessionActive('env-1')).toBe(true)
    expect(isWebRuntimeSessionActive('   ')).toBe(false)
    expect(isWebRuntimeSessionActive(null)).toBe(false)
  })
})

describe('setWebRuntimeTabProps', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('pushes pin to the host via session.tabs.setTabProps for a remote tab', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(ENVIRONMENT_ID)
    mocks.getState.mockReturnValue({})
    const runtimeCall = vi.fn().mockResolvedValue({ id: 'p', ok: true, result: { updated: true } })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

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

  it('maps mirrored browser/editor unified ids before setting host tab props', async () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(ENVIRONMENT_ID)
    mocks.getState.mockReturnValue({})
    mocks.resolveHostSessionTabIdForWebSessionTab.mockImplementation(
      (_state, args: { tabId: string }) =>
        args.tabId === 'local-browser-unified' ? 'host-browser-unified' : null
    )
    const runtimeCall = vi.fn().mockResolvedValue({ id: 'p', ok: true, result: { updated: true } })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    expect(
      setWebRuntimeTabProps({
        worktreeId: WORKTREE_ID,
        tabId: 'local-browser-unified',
        color: '#3b82f6'
      })
    ).toBe(true)

    await vi.waitFor(() => expect(runtimeCall).toHaveBeenCalledTimes(1))
    expect(runtimeCall).toHaveBeenCalledWith({
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.setTabProps',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-browser-unified',
        color: '#3b82f6'
      },
      timeoutMs: 15_000
    })
  })

  it('no-ops for a worktree with no runtime environment (local tab)', () => {
    vi.stubGlobal('__ORCA_WEB_CLIENT__', false)
    mocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    mocks.getState.mockReturnValue({})
    const runtimeCall = vi.fn()
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    expect(
      setWebRuntimeTabProps({ worktreeId: WORKTREE_ID, tabId: 'local-tab', color: '#fff' })
    ).toBe(false)
    expect(runtimeCall).not.toHaveBeenCalled()
  })
})
