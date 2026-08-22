import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from './web-runtime-session-test-harness'

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
  getRuntimeEnvironmentIdForWorktree: vi.fn(),
  hasMaterializedWebRuntimeBrowserPage: vi.fn()
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

vi.mock('./web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

afterEach(() => resetWebSessionCloseIntentForTests())

describe('createWebRuntimeSessionTerminal', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
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

  it('preserves the legacy fresh-agent path when host authority is unavailable', async () => {
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'old-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: []
          }
        }
      }
      if (request.method === 'session.tabs.createTerminal') {
        return {
          id: 'legacy-create',
          ok: true,
          result: {
            tab: { id: 'legacy-tab-1' },
            publicationEpoch: 'epoch-1',
            snapshotVersion: 1
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
        launchAgent: 'codex',
        targetGroupId: 'group-left'
      })
    ).resolves.toEqual({ status: 'created' })

    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.createTerminal',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        afterTabId: undefined,
        targetGroupId: 'group-left',
        command: undefined,
        cwd: undefined,
        startupCommandDelivery: undefined,
        launchAgent: 'codex',
        activate: false,
        select: true,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).toEqual([
      'status.get',
      'session.tabs.createTerminal',
      'session.tabs.list'
    ])
  })

  it('preserves the opaque legacy resume payload on an old host', async () => {
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'old-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: []
          }
        }
      }
      if (request.method === 'session.tabs.createTerminal') {
        return {
          id: 'legacy-create',
          ok: true,
          result: { tab: { id: 'legacy-tab-1' }, publicationEpoch: 'epoch-1', snapshotVersion: 1 }
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
        agentSessionKind: 'resume',
        launchAgent: 'codex',
        command: "codex resume 'session-1'",
        env: { CODEX_PROFILE: 'captured' },
        launchConfig: {
          agentCommand: 'codex',
          agentArgs: '',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        providerSession: { key: 'session_id', id: 'session-1' }
      })
    ).resolves.toEqual({ status: 'created' })

    expect(runtimeCall).toHaveBeenNthCalledWith(2, {
      selector: ENVIRONMENT_ID,
      method: 'session.tabs.createTerminal',
      params: {
        worktree: `id:${WORKTREE_ID}`,
        afterTabId: undefined,
        targetGroupId: undefined,
        command: "codex resume 'session-1'",
        cwd: undefined,
        env: { CODEX_PROFILE: 'captured' },
        startupCommandDelivery: undefined,
        launchConfig: {
          agentCommand: 'codex',
          agentArgs: '',
          agentEnv: { CODEX_PROFILE: 'captured' }
        },
        launchAgent: 'codex',
        activate: false,
        select: true,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
  })

  it('uses the exact legacy OMP resume when an older host only advertises base authority', async () => {
    const methods: string[] = []
    const runtimeCall = vi.fn(async (request: { method: string }) => {
      methods.push(request.method)
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'new-runtime',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: ['agent-session.host-authority.v1']
          }
        }
      }
      if (request.method === 'terminal.ensureAgentSession') {
        return {
          id: 'ensure',
          ok: false,
          error: {
            code: 'invalid_argument',
            message: 'old host rejected OMP'
          }
        }
      }
      return {
        id: 'legacy-create',
        ok: true,
        result: { tab: { id: 'legacy-tab-1' }, publicationEpoch: 'epoch-1', snapshotVersion: 1 }
      }
    })
    vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'resume',
        launchAgent: 'omp',
        command: "omp --resume '/custom/omp/project/session.jsonl'",
        env: { PI_CODING_AGENT_DIR: '/custom/omp' },
        launchConfig: {
          agentCommand: 'omp',
          agentArgs: '',
          agentEnv: { PI_CODING_AGENT_DIR: '/custom/omp' },
          ompResumeFilePath: '/custom/omp/project/session.jsonl'
        },
        providerSession: { key: 'session_id', id: 'session-1' }
      })
    ).resolves.toEqual({ status: 'created' })

    expect(methods).toEqual(['status.get', 'session.tabs.createTerminal', 'session.tabs.list'])
    expect(runtimeCall.mock.calls[1]?.[0]).toMatchObject({
      params: {
        command: "omp --resume '/custom/omp/project/session.jsonl'",
        env: { PI_CODING_AGENT_DIR: '/custom/omp' },
        launchAgent: 'omp'
      }
    })
  })
})
