import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activateWebRuntimeSessionWorktree,
  closeWebRuntimeTerminal,
  consumePendingWebRuntimeSplitMirrorTelemetry,
  isWebRuntimeSessionActive,
  refreshWebRuntimeSessionTabsSnapshot,
  setWebRuntimeTabProps,
  splitWebRuntimeTerminal
} from './web-runtime-session'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import {
  confirmWebAgentSessionHandoffAfterCreate,
  isWebAgentSessionHandoffPostCreateSnapshotConfirmed,
  recordWebAgentSessionHandoff,
  resetWebAgentSessionHandoffsForTests
} from './web-agent-session-handoff'
import { ENVIRONMENT_ID, WORKTREE_ID, makeSnapshot } from './web-runtime-session-test-fixtures'

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
  resolveHostSessionTabIdForWebSessionTab: vi.fn(),
  trackTerminalPaneSplit: vi.fn(),
  deliverLaunchPromptToAgentTab: vi.fn(),
  seedNativeChatLaunchDraftForAgentTab: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn()
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
afterEach(() => resetWebSessionCloseIntentForTests())

describe('refreshWebRuntimeSessionTabsSnapshot', () => {
  afterEach(() => {
    resetWebAgentSessionHandoffsForTests()
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
