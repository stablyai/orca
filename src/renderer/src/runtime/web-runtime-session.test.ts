/* eslint-disable max-lines */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import {
  createWebRuntimeSessionBrowserTab,
  createWebRuntimeSessionTerminal
} from './web-runtime-session'

const mocks = vi.hoisted(() => ({
  getState: vi.fn(),
  setState: vi.fn(),
  createBrowserTab: vi.fn(),
  setRemoteBrowserPageHandle: vi.fn(),
  focusBrowserTabInWorktree: vi.fn(),
  applyFreshWebSessionTabsSnapshot: vi.fn()
}))

vi.mock('../store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState
  }
}))

vi.mock('./web-session-tabs-sync', () => ({
  applyFreshWebSessionTabsSnapshot: mocks.applyFreshWebSessionTabsSnapshot
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
      focusBrowserTabInWorktree: mocks.focusBrowserTabInWorktree
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
      focusAddressBar: true
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

    expect(setStateResults[0]).toEqual({ activeWorktreeId: WORKTREE_ID })
    expect(mocks.applyFreshWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before-stage', activeWorktreeId: 'other-worktree' },
      snapshot,
      ENVIRONMENT_ID
    )
    expect(setStateResults.at(-1)).toEqual({ state: 'after' })
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
      focusBrowserTabInWorktree: mocks.focusBrowserTabInWorktree
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
    expect(mocks.setState).toHaveBeenCalledTimes(2)
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
      focusBrowserTabInWorktree: mocks.focusBrowserTabInWorktree
    })
    mocks.setState.mockImplementation((updater: (state: unknown) => unknown) => {
      updater({
        state: 'before',
        activeWorktreeId: WORKTREE_ID
      })
    })
    mocks.applyFreshWebSessionTabsSnapshot.mockReturnValue({ state: 'after' })
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
        command: 'zsh',
        activate: true
      })
    ).resolves.toBe(true)

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.createTerminal',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        afterTabId: 'host-tab-1::leaf-1',
        command: 'zsh',
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
})
