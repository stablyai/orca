import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft,
  createWebRuntimeSessionTerminal
} from './web-runtime-session'
import { resetWebSessionFocusIntentForTests } from './web-session-focus-intent'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'
import { AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE } from './agent-launch-identity-negotiation'
import {
  ENVIRONMENT_ID,
  WORKTREE_ID,
  FOCUS_LEAF_ID,
  withIdentityCapableStatus,
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

  it('forwards a host-resolved agentLaunch request without a client command or config', async () => {
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
    const runtimeCall = withIdentityCapableStatus(async (request) =>
      request.method === 'session.tabs.createTerminal'
        ? {
            id: 'create-terminal',
            ok: true,
            result: {
              tab: snapshot.tabs[0],
              publicationEpoch: snapshot.publicationEpoch,
              snapshotVersion: snapshot.snapshotVersion,
              agentLaunch: { status: 'launched', receipt: { launchToken: 'tok-1' } }
            }
          }
        : { id: 'list', ok: true, result: snapshot }
    )

    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        targetGroupId: 'group-left',
        agentLaunch: {
          selection: { kind: 'agent', agent: 'claude' },
          prompt: 'fork context',
          promptDelivery: 'draft'
        },
        activate: true
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
        agentLaunch: {
          selection: { kind: 'agent', agent: 'claude' },
          prompt: 'fork context',
          promptDelivery: 'draft'
        },
        activate: false,
        select: true,
        navigation: 'caller'
      },
      timeoutMs: 15_000
    })
  })

  it('treats a pre-spawn agentLaunch failure arm as a launch failure', async () => {
    const runtimeCall = withIdentityCapableStatus(async () => ({
      id: 'create-terminal',
      ok: true,
      result: {
        agentLaunch: { status: 'failed', failure: { code: 'invalid_launch_snapshot' } }
      }
    }))

    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentLaunch: { selection: { kind: 'agent', agent: 'claude' }, allowEmptyPromptLaunch: true }
      })
    ).resolves.toMatchObject({ status: 'failed' })
    // No snapshot refresh follows a failed create.
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).toEqual([
      'status.get',
      'session.tabs.createTerminal'
    ])
  })

  // Security regression: a pre-identity host strips agentLaunch and answers with a
  // bare login shell, which the client would report as a launched agent.
  it('refuses an identity-only launch against a host without the capability', async () => {
    const runtimeCall = withIdentityCapableStatus(
      async () => ({ id: 'list', ok: true, result: makeSnapshot() }),
      ['agent-session.host-authority.v1']
    )

    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentLaunch: { selection: { kind: 'agent', agent: 'claude' }, allowEmptyPromptLaunch: true }
      })
    ).resolves.toEqual({
      status: 'failed',
      message: AGENT_LAUNCH_IDENTITY_UNSUPPORTED_MESSAGE
    })
    expect(runtimeCall.mock.calls.map(([request]) => request.method)).toEqual(['status.get'])
  })

  it('degrades to the client command when the host lacks the identity capability', async () => {
    const runtimeCall = withIdentityCapableStatus(
      async (request) =>
        request.method === 'session.tabs.createTerminal'
          ? {
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
            }
          : { id: 'list', ok: true, result: makeSnapshot() },
      ['agent-session.host-authority.v1']
    )

    vi.stubGlobal('window', {
      api: { runtimeEnvironments: { call: runtimeCall } }
    })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        command: 'claude --resume abc',
        agentLaunch: { selection: { kind: 'agent', agent: 'claude' }, allowEmptyPromptLaunch: true }
      })
    ).resolves.toEqual({ status: 'created' })

    const created = runtimeCall.mock.calls.find(
      ([request]) => request.method === 'session.tabs.createTerminal'
    )?.[0] as unknown as { params: Record<string, unknown> }
    expect(created.params.command).toBe('claude --resume abc')
    // The stripped-on-arrival arm must not ride along on the legacy path.
    expect(created.params.agentLaunch).toBeUndefined()
  })

  it('replays an ambiguous fresh-create failure with the same operation ID', async () => {
    const operationIds: string[] = []
    let createAttempts = 0
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
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
        operationIds.push((request.params as { clientOperationId: string }).clientOperationId)
        createAttempts += 1
        if (createAttempts === 1) {
          throw new Error('connection closed before response')
        }
        return {
          id: 'create',
          ok: true,
          result: {
            terminal: {
              handle: 'term_replayed',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-replayed',
              paneKey: `host-tab-replayed:${FOCUS_LEAF_ID}`
            },
            disposition: 'replayed'
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

    expect(operationIds).toHaveLength(2)
    expect(operationIds[0]).toBe(operationIds[1])
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

  it('delivers generated continuation context after host-authoritative creation', async () => {
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
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
              handle: 'term_created',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-2',
              paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
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
      createWebRuntimeAgentSessionTerminal({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'claude',
        command: 'claude',
        promptAfterReady: 'continue the unfinished task',
        submitPrompt: true,
        forcePromptPaste: true
      })
    ).resolves.toEqual({ outcome: { status: 'created' }, promptDelivered: true })

    const createRequest = runtimeCall.mock.calls.find(
      ([request]) => request.method === 'terminal.createAgentSession'
    )?.[0]
    expect(createRequest).toMatchObject({ params: { agent: 'claude' } })
    expect(createRequest?.params).not.toHaveProperty('prompt')
    expect(mocks.deliverLaunchPromptToAgentTab).toHaveBeenCalledWith({
      tabId: 'web-terminal-host-tab-2',
      content: 'continue the unfinished task',
      agent: 'claude',
      submit: true,
      forcePaste: true
    })
  })

  it('seeds the chat composer for a draft that rode in on the launch command', async () => {
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
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
              handle: 'term_created',
              worktreeId: WORKTREE_ID,
              tabId: 'host-tab-2',
              paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
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
      createWebRuntimeAgentSessionTerminalWithLaunchDraft({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'claude',
        command: "claude --prefill 'https://github.com/o/r/issues/12'",
        launchDraft: 'https://github.com/o/r/issues/12'
      })
    ).resolves.toEqual({ status: 'created' })

    // No paste runs for an argv-prefill draft, so this is the only thing that
    // fills the mirrored tab's composer on this host class.
    expect(mocks.deliverLaunchPromptToAgentTab).not.toHaveBeenCalled()
    expect(mocks.seedNativeChatLaunchDraftForAgentTab).toHaveBeenCalledWith({
      tabId: 'web-terminal-host-tab-2',
      agent: 'claude',
      text: 'https://github.com/o/r/issues/12'
    })
  })
})
