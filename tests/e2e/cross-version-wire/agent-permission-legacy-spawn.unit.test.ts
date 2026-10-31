import { tokenizeStartupCommand } from '../../../src/shared/tui-agent-startup-shell'
import * as startupInputs from '../../../src/shared/agent-startup-plan-inputs'
import { resolveBaselineAgentStartupPlanInputs } from '../../../src/shared/agent-startup-plan-inputs-baseline-test-fixture'
import {
  OrcaRuntimeService,
  getDefaultWorkspaceSession
} from '../../../src/main/runtime/orca-runtime-test-mocks.spec'
import '../../../src/main/runtime/orca-runtime-test-lifecycle.spec'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeRuntimeStoreWithWorkspaceSession
} from '../../../src/main/runtime/orca-runtime-test-fixtures.spec'
import { committingSpawn } from '../../../src/main/runtime/bind-first-pane.test-fixture'
import type { RuntimePtyController } from '../../../src/main/runtime/runtime-pty-controller-contract'
import { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'
import { SESSION_TAB_METHODS } from '../../../src/main/runtime/rpc/methods/session-tabs'
import { TERMINAL_LIFECYCLE_METHODS } from '../../../src/main/runtime/rpc/methods/terminal/terminal-lifecycle-methods'
import { AGENT_SESSION_METHODS } from '../../../src/main/runtime/rpc/methods/agent-session'
import { YOLO_TUI_AGENT_ENV } from '../../../src/shared/tui-agent-permissions'
import { createRuntimeAgentBackgroundTerminal } from '../../../src/renderer/src/lib/runtime-agent-background-create'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { launchAgentInWebHostTab } from '../../../src/renderer/src/lib/launch-agent-web-host-tab'
import { buildAgentStartupPlan } from '../../../src/shared/tui-agent-startup'
import { createWebRuntimeSessionTerminal } from '../../../src/renderer/src/runtime/web-runtime-terminal-creation'
import { resetWebSessionCloseIntentForTests } from '../../../src/renderer/src/runtime/web-session-close-intent'
import {
  ENVIRONMENT_ID,
  WORKTREE_ID,
  makeSnapshot,
  resetTerminalCreateEnvironment,
  stubTerminalCreateEnvironment
} from '../../../src/renderer/src/runtime/web-runtime-session-test-harness'
import { stubRuntimeEnvironmentBridge } from '../../../src/renderer/src/runtime/runtime-environment-bridge-fixture'

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

vi.mock('../../../src/renderer/src/store', () => ({
  useAppStore: {
    getState: mocks.getState,
    setState: mocks.setState,
    subscribe: mocks.subscribe
  }
}))

vi.mock('../../../src/renderer/src/runtime/web-session-tabs-sync/tracking-lifecycle', () => ({
  acceptReplayedWebSessionTabsSnapshot: mocks.acceptReplayedWebSessionTabsSnapshot,
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration
}))
vi.mock('../../../src/renderer/src/runtime/web-session-tabs-sync/snapshot-api', () => ({
  applyWebSessionTabsSnapshot: mocks.applyWebSessionTabsSnapshot
}))
vi.mock('../../../src/renderer/src/runtime/web-session-tabs-sync/tracking-decisions', () => ({
  decideWebSessionTabsSnapshot: mocks.decideWebSessionTabsSnapshot
}))
vi.mock('../../../src/renderer/src/runtime/web-session-tabs-sync/store-patch', () => ({
  applyWebSessionTabsStorePatch: (buildPatch: (state: unknown) => unknown) => {
    mocks.setState(buildPatch)
    return () => {}
  }
}))
vi.mock('../../../src/renderer/src/runtime/web-session-tabs-sync/tracking-mappings', () => ({
  resolveHostSessionTabIdForWebSessionTab: mocks.resolveHostSessionTabIdForWebSessionTab
}))

vi.mock('@/lib/feature-education-telemetry', () => ({
  trackTerminalPaneSplit: mocks.trackTerminalPaneSplit
}))

vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab,
  seedNativeChatLaunchDraftForAgentTab: mocks.seedNativeChatLaunchDraftForAgentTab
}))

vi.mock('../../../src/renderer/src/runtime/web-runtime-browser-materialization', () => ({
  hasMaterializedWebRuntimeBrowserPage: mocks.hasMaterializedWebRuntimeBrowserPage
}))

const currentInputs = startupInputs.resolveAgentStartupPlanInputs
afterEach(() => {
  resetWebSessionCloseIntentForTests()
  vi.restoreAllMocks()
})

describe('createWebRuntimeSessionTerminal', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it.each([
    { agent: 'goose', mode: 'own', hostMode: 'full-access', authority: true, activate: true },
    { agent: 'goose', mode: 'full-access', hostMode: 'own', authority: true, activate: false },
    {
      agent: 'goose',
      mode: 'own',
      hostMode: 'full-access',
      authority: false,
      activate: false,
      userMode: 'approve'
    },
    { agent: 'goose', mode: 'full-access', hostMode: 'own', authority: true, background: true },
    { agent: 'codex', mode: 'ask', hostMode: 'own', authority: true },
    { agent: 'claude', mode: 'ask', hostMode: 'own', authority: true, loose: true },
    { agent: 'goose', mode: 'own', hostMode: 'full-access', authority: true, fail: true }
  ] as const)('preserves a complete launch at the pinned old spawn boundary: %j', async (test) => {
    const settings = {
      agentPermissionDefault: test.hostMode,
      agentDefaultEnv:
        test.mode === 'own' && !('userMode' in test)
          ? {}
          : {
              [test.agent]: {
                PROFILE: 'user',
                ...('userMode' in test ? { GOOSE_MODE: test.userMode } : {})
              }
            }
    }
    const options = {
      permissionMode: test.mode,
      ...(test.agent === 'codex' ? { model: 'gpt-5.4', effort: 'high' } : {})
    }
    const plan = buildAgentStartupPlan({
      ...currentInputs({
        agent: test.agent,
        settings,
        platform: 'linux',
        isRemote: true,
        shell: 'posix',
        agentArgs:
          'loose' in test ? '--dangerously-skip-permissions --verbose' : '--profile "with spaces"',
        sessionOptions: options
      }),
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    if (!plan) {
      throw new Error('Missing startup plan')
    }
    vi.spyOn(startupInputs, 'resolveAgentStartupPlanInputs').mockImplementation(
      resolveBaselineAgentStartupPlanInputs
    )
    const spawn = vi.fn(
      async (_args: Parameters<NonNullable<RuntimePtyController['spawn']>>[0]) => ({
        id: 'baseline-pty'
      })
    )
    const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(getDefaultWorkspaceSession())
    const runtime = new OrcaRuntimeService({
      ...runtimeStore,
      getSettings: () => ({ ...runtimeStore.getSettings(), ...settings })
    })
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const dispatcher = new RpcDispatcher({
      runtime,
      methods: [...SESSION_TAB_METHODS, ...TERMINAL_LIFECYCLE_METHODS, ...AGENT_SESSION_METHODS]
    })
    const state = mocks.getState()
    mocks.getState.mockReturnValue({
      ...state,
      setActiveTabType: vi.fn(),
      activeTabTypeByWorktree: {}
    })
    const creates: string[] = []
    const runtimeCall = vi.fn(async (request: { method: string; params?: unknown }) => {
      if (request.method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: 'baseline-660243e61ff',
            graphStatus: 'ready',
            runtimeProtocolVersion: 3,
            minCompatibleRuntimeClientVersion: 2,
            capabilities: test.authority ? ['agent-session.host-authority.v1'] : []
          }
        }
      }
      if (
        request.method !== 'terminal.create' &&
        request.method !== 'terminal.createAgentSession' &&
        request.method !== 'session.tabs.createTerminal'
      ) {
        return { id: 'placement', ok: true, result: makeSnapshot() }
      }
      creates.push(request.method)
      if (test.agent === 'goose') {
        expect(request.params).toMatchObject({
          command: plan.launchCommand,
          env: plan.env ?? {},
          launchConfig: plan.launchConfig,
          ...('background' in test
            ? { tabId: 'host-tab-1', leafId: 'leaf-1', presentation: 'background' }
            : {
                cwd: TEST_WORKTREE_PATH,
                targetGroupId: 'group',
                activate: false,
                select: 'activate' in test ? test.activate : true
              })
        })
      }
      const response = await dispatcher.dispatch(
        { id: 'create', authToken: 'test', method: request.method, params: request.params },
        { clientKind: 'runtime', clientId: 'paired-client' }
      )
      if ('fail' in test) {
        throw new Error('ambiguous create failure')
      }
      return response
    })
    stubRuntimeEnvironmentBridge({ call: runtimeCall })
    if ('background' in test) {
      await createRuntimeAgentBackgroundTerminal({
        environmentId: ENVIRONMENT_ID,
        worktreeId: TEST_WORKTREE_ID,
        tabId: 'host-tab-1',
        leafId: 'leaf-1',
        agent: test.agent,
        sessionOptions: plan.sessionOptions,
        legacy: {
          command: plan.launchCommand,
          env: plan.env ?? {},
          launchConfig: plan.launchConfig,
          launchToken: 'token'
        }
      })
    } else {
      const result = await launchAgentInWebHostTab({
        agent: test.agent,
        worktreeId: TEST_WORKTREE_ID,
        environmentId: ENVIRONMENT_ID,
        buildStartup: () => ({
          startupPlan: plan,
          pasteDraftAfterLaunch: null,
          submitPastedPrompt: false
        }),
        prompt: '',
        promptDelivery: 'auto-submit',
        activate: 'activate' in test ? test.activate : true,
        cwd: TEST_WORKTREE_PATH,
        groupId: 'group',
        viewMode: 'terminal'
      })
      expect(result.outcome.status).toBe('fail' in test ? 'failed' : 'created')
    }
    expect(creates).toEqual([
      test.agent === 'goose'
        ? 'background' in test
          ? 'terminal.create'
          : 'session.tabs.createTerminal'
        : 'terminal.createAgentSession'
    ])
    expect(spawn).toHaveBeenCalledTimes(1)
    const final = spawn.mock.calls[0][0]
    expect(final.cwd).toBe(TEST_WORKTREE_PATH)
    expect(final.env).toMatchObject(plan.env ?? {})
    expect(final.env?.GOOSE_MODE).toBe(plan.env?.GOOSE_MODE)
    const expected = tokenizeStartupCommand(plan.launchCommand, 'posix')
    if (final.command === undefined) {
      throw new Error('Missing final command')
    }
    const actual = tokenizeStartupCommand(final.command, 'posix')
    if (!expected.ok || !actual.ok) {
      throw new Error('Invalid final command')
    }
    expect(actual.tokens.toSorted()).toEqual(expected.tokens.toSorted())
    if (test.agent === 'goose') {
      expect(final.command).toBe(plan.launchCommand)
      expect(final.launchConfig).toEqual(plan.launchConfig)
      expect(final.startupCommandDelivery).toBe(plan.startupCommandDelivery)
      expect(plan.env?.GOOSE_MODE).toBe(
        'userMode' in test
          ? test.userMode
          : test.mode === 'own'
            ? undefined
            : YOLO_TUI_AGENT_ENV.goose?.GOOSE_MODE
      )
    }
    if ('loose' in test) {
      expect(plan.sessionOptions?.permissionMode).toBeUndefined()
    }
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
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

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

  it.each([
    {
      agent: 'codex' as const,
      predecessor: 'web-terminal-host-tab-1',
      afterTabId: 'web-terminal-host-tab-1%3A%3Aleaf-1'
    },
    {
      agent: undefined,
      predecessor: 'web-terminal-host-tab-1',
      afterTabId: 'web-terminal-host-tab-1%3A%3Aleaf-1'
    },
    { agent: undefined, predecessor: 'local-browser-tab', afterTabId: 'local-browser-tab' },
    {
      agent: undefined,
      predecessor: 'web-terminal-host-tab-1%3A%3Aleaf-1',
      afterTabId: 'web-terminal-host-tab-1%3A%3Aleaf-1'
    }
  ])(
    'settles after $afterTabId for $agent creation without activating it',
    async ({ agent, predecessor, afterTabId }) => {
      const successor = 'web-terminal-host-tab-3'
      const created = 'web-terminal-host-tab-2'
      const reorderUnifiedTabs = vi.fn()
      mocks.getState.mockReturnValue({
        ...mocks.getState(),
        unifiedTabsByWorktree: {
          [WORKTREE_ID]: [predecessor, successor, created].map((id) => ({
            id,
            groupId: 'client-group'
          }))
        },
        groupsByWorktree: {
          [WORKTREE_ID]: [{ id: 'client-group', tabOrder: [predecessor, successor, created] }]
        },
        reorderUnifiedTabs,
        moveUnifiedTabToGroup: mocks.moveUnifiedTabToGroup
      })
      const runtimeCall = vi.fn(async (request: { method: string }) => ({
        id: request.method,
        ok: true,
        result:
          request.method === 'session.tabs.createTerminal'
            ? { tab: { id: 'host-tab-2::leaf-2' }, publicationEpoch: 'epoch-1', snapshotVersion: 2 }
            : makeSnapshot()
      }))
      stubRuntimeEnvironmentBridge({ call: runtimeCall })

      await expect(
        createWebRuntimeSessionTerminal({
          worktreeId: WORKTREE_ID,
          afterTabId,
          agent,
          activate: false
        })
      ).resolves.toEqual({ status: 'created' })

      expect(reorderUnifiedTabs).toHaveBeenCalledExactlyOnceWith(
        'client-group',
        [predecessor, created, successor],
        { recordInteraction: false }
      )
      expect(mocks.moveUnifiedTabToGroup).not.toHaveBeenCalled()
    }
  )

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

    stubRuntimeEnvironmentBridge({ call: runtimeCall })

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
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

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
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

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
    stubRuntimeEnvironmentBridge({ call: runtimeCall })

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
