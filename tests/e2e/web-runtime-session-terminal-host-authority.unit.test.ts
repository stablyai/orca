import { launchAgentInWebHostTab } from '../../src/renderer/src/lib/launch-agent-web-host-tab'
import {
  independentActionEffortPlan,
  consumeOldHostPreparedCommand
} from './prepared-action-launch.test-fixture'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TrackingDecisions from '../../src/renderer/src/runtime/web-session-tabs-sync/tracking-decisions'
import {
  createWebRuntimeAgentSessionTerminal,
  createWebRuntimeAgentSessionTerminalWithLaunchDraft,
  createWebRuntimeSessionTerminal
} from '../../src/renderer/src/runtime/web-runtime-terminal-creation'
import { peekWebSessionFocusIntent } from '../../src/renderer/src/runtime/web-session-focus-intent'
import { resetWebSessionCloseIntentForTests } from '../../src/renderer/src/runtime/web-session-close-intent'
import {
  ENVIRONMENT_ID,
  FOCUS_LEAF_ID,
  RUNTIME_EXECUTION_HOST_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from '../../src/renderer/src/runtime/web-runtime-session-test-harness'
import { stubRuntimeEnvironmentBridge } from '../../src/renderer/src/runtime/runtime-environment-bridge-fixture'

const mocks = vi.hoisted(() => ({
  changedAgentPaneKeys: new Set<string>(),
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

vi.mock('../../src/renderer/src/store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('../../src/renderer/src/runtime/web-session-tabs-sync/tracking-lifecycle', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration
}))
vi.mock('../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api', () => ({
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot
}))
vi.mock(
  '../../src/renderer/src/runtime/web-session-tabs-sync/tracking-decisions',
  async (importOriginal) => ({
    ...(await importOriginal<typeof TrackingDecisions>()),
    decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot
  })
)
vi.mock('../../src/renderer/src/runtime/web-session-tabs-sync/store-patch', () => ({
  applyWebSessionTabsStorePatch: (
    buildPatch: (state: unknown, changedAgentPaneKeys: Set<string>) => unknown
  ) => {
    mocks.setState((state: unknown) => buildPatch(state, mocks.changedAgentPaneKeys))
    return () => {}
  }
}))
vi.mock('../../src/renderer/src/runtime/web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('../../src/renderer/src/runtime/web-runtime-browser-materialization', () => ({
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

  it.each(['claude', 'codex'] as const)(
    'delivers independent %s effort through the real prepared web callback',
    async (agent) => {
      const plan = independentActionEffortPlan(agent)
      const spawn = vi.fn(consumeOldHostPreparedCommand)
      const runtimeCall = vi.fn(async (request) => {
        if (request.method === 'status.get') {
          return {
            ok: true,
            result: {
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 2,
              capabilities: ['agent-session.host-authority.v1']
            }
          }
        }
        if (request.method === 'session.tabs.createTerminal') {
          await spawn(request.params)
          return { ok: true, result: { tab: { id: 'host-prepared', leafId: 'leaf-1' } } }
        }
        if (request.method !== 'session.tabs.list') {
          throw new Error(`Unexpected create route ${request.method}`)
        }
        return { ok: true, result: makeSnapshot() }
      })
      stubRuntimeEnvironmentBridge({ call: runtimeCall })
      await expect(
        launchAgentInWebHostTab({
          agent,
          worktreeId: WORKTREE_ID,
          environmentId: ENVIRONMENT_ID,
          buildStartup: () => ({
            startupPlan: plan,
            pasteDraftAfterLaunch: null,
            submitPastedPrompt: false
          }),
          prompt: 'Fix checks',
          promptDelivery: 'auto-submit',
          activate: false
        })
      ).resolves.toEqual({
        delivered: true,
        failureNotified: false,
        outcome: { status: 'created' },
        tabId: 'web-terminal-host-prepared'
      })
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(await spawn.mock.results[0].value).toEqual({
        command: plan.launchCommand,
        env: { ACTION_PROFILE: 'captured' },
        envToDelete: undefined,
        launchConfig: plan.launchConfig,
        launchAgent: agent,
        startupCommandDelivery: agent === 'codex' ? 'shell-ready' : undefined
      })
      expect(
        runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'session.tabs.createTerminal'
        )
      ).toHaveLength(1)
      expect(
        runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'terminal.createAgentSession'
        )
      ).toHaveLength(0)
    }
  )

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
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(
      createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        environmentId: ENVIRONMENT_ID
      })
    ).resolves.toEqual({ status: 'created' })

    expect(selectedHosts).toEqual([RUNTIME_EXECUTION_HOST_ID])
  })

  it.each(
    [
      { sessionKind: 'fresh' as const, activate: true },
      { sessionKind: 'fresh' as const, activate: false },
      { sessionKind: 'resume' as const, activate: true },
      { sessionKind: 'resume' as const, activate: false }
    ].flatMap((entry) =>
      [true, false].map((keyboardSupported) => ({ ...entry, keyboardSupported }))
    )
  )(
    'keeps $sessionKind host creation background with activate=$activate and keyboard=$keyboardSupported',
    async ({ sessionKind, activate, keyboardSupported }) => {
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
              capabilities: [
                'agent-session.host-authority.v1',
                ...(keyboardSupported ? ['agent-session.keyboard.v1'] : [])
              ]
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
      stubRuntimeEnvironmentBridge({ call: runtimeCall })

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
      if (keyboardSupported) {
        expect(authorityRequest).toHaveProperty('params.terminalKittyKeyboardProtocol', true)
      } else {
        expect(authorityRequest).not.toHaveProperty('params.terminalKittyKeyboardProtocol')
      }
      expect(peekWebSessionFocusIntent({ environmentId: ENVIRONMENT_ID }, WORKTREE_ID)).toEqual(
        activate ? { hostTabId, leafId: FOCUS_LEAF_ID } : null
      )
      expect(mocks.acceptReplayedWebSessionTabsSnapshot).toHaveBeenCalledTimes(activate ? 1 : 0)
    }
  )

  it.each([
    { gated: false, authority: false },
    { gated: true, authority: true }
  ])(
    'routes a Kimi resume by capability (advertised=$gated) instead of the generic host-authority probe',
    async ({ gated, authority }) => {
      // Old hosts reject widened ensureAgentSession enums without retry; per-agent probes preserve Kimi’s legacy fallback.
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
              capabilities: [
                'agent-session.host-authority.v1',
                ...(gated ? ['agent-session.kimi-resume.v1'] : [])
              ]
            }
          }
        }
        if (request.method === 'terminal.ensureAgentSession') {
          return {
            id: 'ensure',
            ok: true,
            result: {
              terminal: {
                handle: 'term-kimi',
                worktreeId: WORKTREE_ID,
                tabId: 'host-tab-kimi',
                paneKey: `host-tab-kimi:${FOCUS_LEAF_ID}`
              },
              disposition: 'created'
            }
          }
        }
        if (request.method === 'session.tabs.createTerminal') {
          return {
            id: 'legacy-create',
            ok: true,
            result: { tab: { id: 'host-tab-kimi', leafId: FOCUS_LEAF_ID } }
          }
        }
        return { id: 'list', ok: true, result: makeSnapshot() }
      })
      stubRuntimeEnvironmentBridge({ call: runtimeCall })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          agentSessionKind: 'resume',
          launchAgent: 'kimi',
          command: "kimi '--session' 'session_431324d7'",
          providerSession: { key: 'session_id', id: 'session_431324d7' }
        })
      ).resolves.toEqual({ status: 'created' })

      const methods = runtimeCall.mock.calls.map(([request]) => request.method)
      expect(methods.includes('terminal.ensureAgentSession')).toBe(authority)
      expect(methods.includes('session.tabs.createTerminal')).toBe(!authority)
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

    stubRuntimeEnvironmentBridge({ call: runtimeCall })

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
    expect(mocks.applyWebSessionTabsSnapshot).toHaveBeenCalledWith(
      { state: 'before', activeWorktreeId: WORKTREE_ID },
      snapshot,
      ENVIRONMENT_ID,
      undefined,
      undefined,
      mocks.changedAgentPaneKeys
    )
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
      stubRuntimeEnvironmentBridge({ call: runtimeCall })

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
      expect(
        runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'session.tabs.createTerminal'
        )
      ).toHaveLength(0)
    }
  )

  it.each([false, true])(
    'bounds ambiguous authority replay with exhaustion=%s and the same operation ID',
    async (exhausted) => {
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
          if (createAttempts === 1 || exhausted) {
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
      stubRuntimeEnvironmentBridge({ call: runtimeCall })

      const result = await createWebRuntimeSessionTerminal({
        worktreeId: WORKTREE_ID,
        launchAgent: 'codex',
        targetGroupId: 'group-left'
      })
      expect(result).toEqual(
        exhausted
          ? { status: 'failed', message: 'connection closed before response' }
          : { status: 'created' }
      )

      expect(operationIds).toHaveLength(2)
      expect(operationIds[0]).toBe(operationIds[1])
      expect(
        runtimeCall.mock.calls.filter(
          ([request]) => request.method === 'session.tabs.createTerminal'
        )
      ).toHaveLength(0)
    }
  )

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
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

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
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

    await expect(
      createWebRuntimeAgentSessionTerminalWithLaunchDraft({
        worktreeId: WORKTREE_ID,
        agentSessionKind: 'fresh',
        agent: 'claude',
        command: "claude --prefill 'https://github.com/o/r/issues/12'",
        launchDraft: 'https://github.com/o/r/issues/12'
      })
    ).resolves.toEqual({ outcome: { status: 'created' }, promptDelivered: true })

    // Argv-prefill sends no paste, so only this seeds the mirrored composer.
    expect(mocks.deliverLaunchPromptToAgentTab).not.toHaveBeenCalled()
    expect(mocks.seedNativeChatLaunchDraftForAgentTab).toHaveBeenCalledWith({
      tabId: 'web-terminal-host-tab-2',
      agent: 'claude',
      text: 'https://github.com/o/r/issues/12'
    })
  })
})
