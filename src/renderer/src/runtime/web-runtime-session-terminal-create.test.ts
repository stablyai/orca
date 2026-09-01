import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import {
  peekWebSessionFocusIntent,
  resetWebSessionFocusIntentForTests
} from './web-session-focus-intent'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import {
  ENVIRONMENT_ID,
  RUNTIME_EXECUTION_HOST_ID,
  WORKTREE_ID,
  FOCUS_LEAF_ID,
  makeSnapshot,
  primeTerminalSessionState
} from './web-runtime-session-test-fixtures'

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
  decideWebSessionTabsSnapshot: vi.fn(),
  settleWebSessionTabsMirror: vi.fn(),
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
    return mocks.settleWebSessionTabsMirror
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

describe('createWebRuntimeSessionTerminal', () => {
  beforeEach(() => {
    primeTerminalSessionState(mocks)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearRuntimeCompatibilityCacheForTests()
    resetWebSessionFocusIntentForTests()
    vi.clearAllMocks()
  })

  it('keeps same-ID local and runtime worktrees on the selected runtime owner', async () => {
    const selectedHosts: (string | undefined)[] = []
    mocks.setActiveWorktree.mockImplementation((_worktreeId: string, executionHostId?: string) => {
      selectedHosts.push(executionHostId)
    })
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'create',
        ok: true,
        result: { tab: { id: 'host-tab-1', leafId: 'host-leaf-1' } }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toEqual({ status: 'created' })

    expect(selectedHosts).toEqual([RUNTIME_EXECUTION_HOST_ID])
  })

  it.each([
    { sessionKind: 'fresh' as const, activate: true },
    { sessionKind: 'fresh' as const, activate: false },
    { sessionKind: 'resume' as const, activate: true },
    { sessionKind: 'resume' as const, activate: false }
  ])(
    'keeps $sessionKind host creation background with activate=$activate while focus stays client-owned',
    async ({ sessionKind, activate }) => {
      const hostTabId = `host-${sessionKind}-${activate ? 'active' : 'background'}`
      const runtimeCall = vi.fn(async (request: { method: string }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        }
        if (
          request.method === 'terminal.createAgentSession' ||
          request.method === 'terminal.ensureAgentSession'
        ) {
          return {
            id: 'agent-session',
            ok: true,
            result: {
              terminal: {
                handle: `term-${sessionKind}`,
                worktreeId: WORKTREE_ID,
                tabId: hostTabId,
                paneKey: `${hostTabId}:${FOCUS_LEAF_ID}`
              },
              disposition: 'created'
            }
          }
        }
        return { id: 'list', ok: true, result: makeSnapshot() }
      })
      vi.stubGlobal('window', {
        api: { runtimeEnvironments: { call: runtimeCall } }
      })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          agentSessionKind: sessionKind,
          launchAgent: 'codex',
          ...(sessionKind === 'resume'
            ? {
                command: "codex resume 'session-1'",
                providerSession: { key: 'session_id' as const, id: 'session-1' }
              }
            : {}),
          activate
        })
      ).resolves.toEqual({ status: 'created' })

      const authorityMethod =
        sessionKind === 'resume' ? 'terminal.ensureAgentSession' : 'terminal.createAgentSession'
      const authorityRequest = runtimeCall.mock.calls.find(
        ([request]) => request.method === authorityMethod
      )?.[0]
      expect(authorityRequest).toMatchObject({
        selector: ENVIRONMENT_ID,
        method: authorityMethod,
        params: { presentation: 'background' }
      })
      expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toEqual(
        activate ? { hostTabId, leafId: FOCUS_LEAF_ID } : null
      )
      expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledTimes(activate ? 1 : 0)
    }
  )

  it('creates paired web agents through host authority so activation is mirrored', async () => {
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
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'runtime-1',
          graphStatus: 'ready',
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2,
          capabilities: ['agent-session.host-authority.v1']
        }
      })
      .mockResolvedValueOnce({
        id: 'create-terminal',
        ok: true,
        result: {
          terminal: {
            id: 'pty-2',
            handle: 'term_2',
            title: 'Terminal 2',
            cwd: '/repo/packages/app',
            worktreeId: WORKTREE_ID,
            tabId: 'host-tab-2',
            paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
          },
          disposition: 'created'
        }
      })
      .mockResolvedValueOnce({
        id: 'move',
        ok: true,
        result: { moved: true }
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
        targetGroupId: 'group-left',
        command: "codex 'linked issue context'",
        cwd: '/repo/packages/app',
        env: { CODEX_PROFILE: 'captured' },
        envToDelete: ['CODEX_HOME', 'ORCA_CODEX_HOME'],
        startupCommandDelivery: 'shell-ready',
        launchConfig: {
          agentArgs: '--model gpt-5',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        launchAgent: 'codex',
        prompt: 'linked issue context',
        promptDelivery: 'draft',
        agentArgs: '--model gpt-5 --profile captured',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        viewMode: 'chat',
        activate: true
      })
    ).resolves.toEqual({ status: 'created' })

    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      expectedEnvironmentPairingRevision: undefined,
      method: 'terminal.createAgentSession',
      params: {
        clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
        worktree: `id:${WORKTREE_ID}`,
        agent: 'codex',
        prompt: 'linked issue context',
        promptDelivery: 'draft',
        agentArgs: '--model gpt-5 --profile captured',
        launchPreferences: { model: 'gpt-5', effort: 'high' },
        startupCwd: '/repo/packages/app',
        viewMode: 'chat',
        presentation: 'background'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(3, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.move',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        tabId: 'host-tab-2',
        targetGroupId: 'group-left',
        kind: 'move-to-group'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall).toHaveBeenNthCalledWith(4, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.list',
      params: {
        worktree: `id:${WORKTREE_ID}`
      },
      timeoutMs: 15_000
    })
    // Why: activation mirroring is host-authoritative — the post-create list must
    // pass through the frame's own decision before it may patch the local store.
    expect(mocks.decideWebSessionTabsSnapshot).toHaveBeenCalledWith(snapshot, ENVIRONMENT_ID)
    expect(mocks.applyWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before', activeWorktreeId: WORKTREE_ID },
      snapshot,
      ENVIRONMENT_ID
    )
    expect(mocks.settleWebSessionTabsMirror).toHaveBeenCalled()
  })

  it('keeps exact legacy ordering when structured creation cannot express afterTabId', async () => {
    const runtimeCall = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'legacy-create',
        ok: true,
        result: {
          tab: { id: 'host-tab-2' },
          publicationEpoch: 'epoch-1',
          snapshotVersion: 2
        }
      })
      .mockResolvedValueOnce({ id: 'list', ok: true, result: makeSnapshot() })
    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        afterTabId: 'web-terminal-host-tab-1%3A%3Aleaf-1',
        targetGroupId: 'group-left',
        agentSessionKind: 'fresh',
        agent: 'codex',
        activate: true
      })
    ).resolves.toEqual({ status: 'created' })

    expect(runtimeCall).toHaveBeenNthCalledWith(1, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.createTerminal',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        afterTabId: 'host-tab-1::leaf-1',
        targetGroupId: 'group-left',
        command: undefined,
        cwd: undefined,
        startupCommandDelivery: undefined,
        agent: 'codex',
        activate: false,
        select: true,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).toEqual([
      'session.tabs.createTerminal',
      'session.tabs.list'
    ])
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
    ).resolves.toEqual({ status: 'created' })

    expect(setStateResults).not.toContainEqual({ activeWorktreeId: WORKTREE_ID })
  })

  it.each(['session.tabs.move', 'session.tabs.list'] as const)(
    'treats %s failure after host creation as accepted so callers do not duplicate the agent',
    async (failedMethod) => {
      const runtimeCall = vi.fn(async (request: { method: string }) => {
        if (request.method === 'status.get') {
          return {
            id: 'status',
            ok: true,
            result: {
              runtimeId: 'runtime-1',
              graphStatus: 'ready',
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        }
        if (request.method === 'terminal.createAgentSession') {
          return {
            id: 'create',
            ok: true,
            result: {
              terminal: {
                id: 'pty-created',
                handle: 'term_created',
                title: 'Codex',
                cwd: '/repo',
                worktreeId: WORKTREE_ID,
                tabId: 'host-tab-created',
                paneKey: `host-tab-created:${FOCUS_LEAF_ID}`
              },
              disposition: 'created'
            }
          }
        }
        if (request.method === failedMethod) {
          throw new Error(`${failedMethod} unavailable`)
        }
        return { id: 'ok', ok: true, result: makeSnapshot() }
      })
      vi.stubGlobal('window', {
        api: { runtimeEnvironments: { call: runtimeCall } }
      })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          targetGroupId: failedMethod === 'session.tabs.move' ? 'group-left' : undefined,
          launchAgent: 'codex',
          activate: true
        })
      ).resolves.toEqual({ status: 'created' })

      expect(
        runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'terminal.createAgentSession'
        )
      ).toHaveLength(1)
    }
  )
})
