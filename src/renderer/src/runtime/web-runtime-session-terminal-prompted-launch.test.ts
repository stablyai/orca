import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import { resetWebSessionCloseIntentForTests } from './web-session-close-intent'
import {
  ENVIRONMENT_ID,
  FOCUS_LEAF_ID,
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
  getWebSessionTabsTrackingGeneration: vi.fn(() => 0),
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
  getWebSessionTabsTrackingGeneration: mocks.getWebSessionTabsTrackingGeneration,
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

type RuntimeRequest = { method: string; params?: Record<string, unknown> }

type RuntimeCall = ReturnType<typeof vi.fn<(request: RuntimeRequest) => Promise<unknown>>>

function stubRuntime(capabilities: string[]): RuntimeCall {
  const runtimeCall = vi.fn<(request: RuntimeRequest) => Promise<unknown>>(async (request) => {
    if (request.method === 'status.get') {
      return {
        id: 'status',
        ok: true,
        result: {
          runtimeId: 'runtime-1',
          graphStatus: 'ready',
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2,
          capabilities
        }
      }
    }
    if (request.method === 'terminal.createAgentSession') {
      return {
        id: 'create',
        ok: true,
        result: {
          terminal: {
            handle: 'term-created',
            worktreeId: WORKTREE_ID,
            tabId: 'host-tab-2',
            paneKey: `host-tab-2:${FOCUS_LEAF_ID}`
          },
          disposition: 'created'
        }
      }
    }
    if (request.method === 'session.tabs.createTerminal') {
      return {
        id: 'legacy-create',
        ok: true,
        result: { tab: { id: 'host-tab-2', leafId: FOCUS_LEAF_ID } }
      }
    }
    return { id: 'list', ok: true, result: makeSnapshot() }
  })
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call: runtimeCall } } })
  return runtimeCall
}

function callsFor(runtimeCall: RuntimeCall, method: string): RuntimeRequest[] {
  return runtimeCall.mock.calls.map(([request]) => request).filter((r) => r.method === method)
}

// Shapes launchAgentInNewTab hands this API for a typed prompt (row 7 producer pins in
// launch-agent-in-new-tab-web-host-launch.test.ts); the assembled command already carries the prompt.
type PromptedLaunch = {
  name: string
  agent: 'claude' | 'codex'
  args: {
    command: string
    startupCommandDelivery?: 'shell-ready'
    launchConfig: { agentCommand: string; agentArgs: string; agentEnv: Record<string, string> }
  }
}

const PROMPTED_LAUNCHES: PromptedLaunch[] = [
  {
    name: 'Claude',
    agent: 'claude',
    args: {
      command: "claude '--x' 'fix it'",
      launchConfig: { agentCommand: "claude '--x'", agentArgs: '--x', agentEnv: {} }
    }
  },
  {
    name: 'Codex shell-ready',
    agent: 'codex',
    args: {
      command: "codex '--x' 'fix it'",
      startupCommandDelivery: 'shell-ready',
      launchConfig: { agentCommand: "codex '--x'", agentArgs: '--x', agentEnv: {} }
    }
  }
]

function launchArgs(launch: PromptedLaunch) {
  return {
    worktreeId: WORKTREE_ID,
    environmentId: ENVIRONMENT_ID,
    targetGroupId: 'group-1',
    activate: true,
    viewMode: 'terminal' as const,
    agentSessionKind: 'fresh' as const,
    agent: launch.agent,
    launchAgent: launch.agent,
    env: { A: '1' },
    prompt: 'fix it',
    promptDelivery: 'auto-submit' as const,
    ...launch.args
  }
}

// Pins main's current launch behaviour as the convergence parity baseline (row 7 with prompt, Q2):
// a modern host gets intent plus the client's default args; a legacy host gets the verbatim plan.
describe('row 7: prompted paired launch wire shape on main', () => {
  beforeEach(() => {
    stubTerminalCreateEnvironment(mocks)
  })

  afterEach(() => {
    resetTerminalCreateEnvironment()
  })

  it.each(PROMPTED_LAUNCHES)(
    '$name on a host-authority host sends intent with launchConfig.agentArgs as agentArgs',
    async (launch) => {
      const runtimeCall = stubRuntime(['agent-session.host-authority.v1'])

      await expect(createWebRuntimeSessionTerminal(launchArgs(launch))).resolves.toEqual({
        status: 'created'
      })

      // main today: command, env, launchConfig and startupCommandDelivery never reach the host;
      // agentArgs is the window's client-side default args, sent as an override.
      expect(callsFor(runtimeCall, 'terminal.createAgentSession')).toStrictEqual([
        {
          selector: ENVIRONMENT_ID,
          expectedEnvironmentPairingRevision: undefined,
          method: 'terminal.createAgentSession',
          params: {
            clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
            worktree: `id:${WORKTREE_ID}`,
            agent: launch.agent,
            prompt: 'fix it',
            promptDelivery: 'auto-submit',
            agentArgs: '--x',
            viewMode: 'terminal',
            presentation: 'background'
          },
          timeoutMs: 15_000
        }
      ])
      expect(callsFor(runtimeCall, 'session.tabs.createTerminal')).toStrictEqual([])
    }
  )

  it.each(PROMPTED_LAUNCHES)(
    '$name on a host without the capability sends the verbatim plan to the legacy create',
    async (launch) => {
      const runtimeCall = stubRuntime([])

      await expect(createWebRuntimeSessionTerminal(launchArgs(launch))).resolves.toEqual({
        status: 'created'
      })

      // main today: prompt and promptDelivery are dropped; the prompt rides only inside command.
      expect(callsFor(runtimeCall, 'session.tabs.createTerminal')).toStrictEqual([
        {
          selector: ENVIRONMENT_ID,
          expectedEnvironmentPairingRevision: undefined,
          method: 'session.tabs.createTerminal',
          params: {
            worktree: `id:${WORKTREE_ID}`,
            afterTabId: undefined,
            targetGroupId: 'group-1',
            command: launch.args.command,
            cwd: undefined,
            env: { A: '1' },
            startupCommandDelivery: launch.args.startupCommandDelivery,
            launchConfig: launch.args.launchConfig,
            agent: launch.agent,
            launchAgent: launch.agent,
            viewMode: 'terminal',
            activate: false,
            select: true,
            navigation: 'caller'
          },
          timeoutMs: 15_000
        }
      ])
      expect(callsFor(runtimeCall, 'terminal.createAgentSession')).toStrictEqual([])
    }
  )
})
