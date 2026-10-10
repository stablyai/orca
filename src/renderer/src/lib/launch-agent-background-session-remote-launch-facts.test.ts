import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as LaunchModuleNamespace from './launch-agent-background-session'
import type * as RuntimeRpcClientNamespace from '@/runtime/runtime-rpc-client'
import type * as MultiplexerNamespace from '@/runtime/remote-runtime-terminal-multiplexer'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { AGENT_SESSION_HOST_AUTHORITY_CAPABILITY } from '../../../shared/agent-session-host-authority'
import { AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import {
  AGENT_BACKGROUND_SESSION_UUID_RE as UUID_RE,
  createAgentBackgroundSessionTestState,
  resetAgentBackgroundSessionTestHarness,
  useRemoteAgentBackgroundRuntime
} from '@/lib/agent-background-session-test-state'

const mockSpawn = vi.fn()
const mockKill = vi.fn()
const mockWrite = vi.fn()
const mockRuntimeEnvironmentCall = vi.fn()
const mockRuntimeEnvironmentTransportCall = vi.fn()
const mockRuntimeEnvironmentSubscribe = vi.fn()
const mockCreateTab = vi.fn()
const mockSetTabCustomTitle = vi.fn()
const mockUpdateTabPtyId = vi.fn()
const mockCloseTab = vi.fn()
const mockSetTabLayout = vi.fn()
const mockRegisterAgentLaunchConfig = vi.fn()
const mockRegisterEagerPtyBuffer = vi.fn()
const mockSubscribeToPtyData = vi.fn()
const mockSubscribeToPtyExit = vi.fn()
const mockPasteDraftWhenAgentReady = vi.fn()
const mockDispatchEvent = vi.fn()
// Sink for the harness platform-mock reset: this file runs the real launch-platform rule.
const unusedLaunchPlatformMock = vi.fn()
const state = createAgentBackgroundSessionTestState({
  createTab: mockCreateTab,
  setTabCustomTitle: mockSetTabCustomTitle,
  updateTabPtyId: mockUpdateTabPtyId,
  closeTab: mockCloseTab,
  setTabLayout: mockSetTabLayout,
  registerAgentLaunchConfig: mockRegisterAgentLaunchConfig
})

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => state,
    subscribe: vi.fn(() => () => {})
  }
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  pasteDraftWhenAgentReady: mockPasteDraftWhenAgentReady
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  registerEagerPtyBuffer: mockRegisterEagerPtyBuffer,
  subscribeToPtyExit: mockSubscribeToPtyExit
}))

vi.mock('@/components/terminal-pane/pty-data-sidecar-subscriptions', () => ({
  subscribeToPtyData: mockSubscribeToPtyData
}))

type Client = 'win32' | 'linux'
type ClientModules = {
  launch: typeof LaunchModuleNamespace
  rpc: typeof RuntimeRpcClientNamespace
  multiplexer: typeof MultiplexerNamespace
}

const USER_AGENT: Record<Client, string> = {
  win32: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Orca',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) Orca'
}
const modulesByClient = new Map<Client, ClientModules>()

async function loadForClient(client: Client): Promise<ClientModules> {
  // Why: CLIENT_PLATFORM reads the user agent at import, the renderer app platform at call time.
  vi.stubGlobal('navigator', { userAgent: USER_AGENT[client] })
  let modules = modulesByClient.get(client)
  if (!modules) {
    vi.resetModules()
    modules = {
      launch: await import('./launch-agent-background-session'),
      rpc: await import('@/runtime/runtime-rpc-client'),
      multiplexer: await import('@/runtime/remote-runtime-terminal-multiplexer')
    }
    modulesByClient.set(client, modules)
  }
  // Why: each client graph has its own capability cache; a stale verdict would pick the wrong path.
  modules.rpc.clearRuntimeCompatibilityCacheForTests()
  modules.multiplexer.resetRemoteRuntimeTerminalMultiplexersForTests()
  return modules
}

// Why an apostrophe: it is the byte that tells POSIX and PowerShell quoting apart.
const PROMPT = "don't stop"
const POSIX_PROMPT = `'don'"'"'t stop'`
const CLIENT_OPERATION_ID_RE = /^\d{13}-[0-9a-f]{32}$/

/** Serves status.get with the given capabilities removed; everything else reaches the RPC mock. */
function serveRuntimeStatusWithout(removed: readonly string[]): void {
  mockRuntimeEnvironmentTransportCall.mockImplementation((request: { method: string }) => {
    const status = createCompatibleRuntimeStatusResponseIfNeeded(request)
    if (status?.ok) {
      return Promise.resolve({
        ...status,
        result: {
          ...status.result,
          capabilities: status.result.capabilities?.filter(
            (capability) => !removed.includes(capability)
          )
        }
      })
    }
    return mockRuntimeEnvironmentCall(request)
  })
}

type CreateParams = Record<string, unknown> & {
  tabId?: string
  leafId?: string
  launchToken?: string
  placement?: { tabId: string; leafId: string }
}
type RpcRequest = Record<string, unknown> & { method: string; params: CreateParams }

function rpcRequests(): RpcRequest[] {
  return mockRuntimeEnvironmentCall.mock.calls.map((call) => call[0])
}

function onlyCreateRequest(): RpcRequest {
  const creates = rpcRequests().filter((request) => request.method.startsWith('terminal.create'))
  expect(creates).toHaveLength(1)
  return creates[0]
}

function expectEnvelope(request: Record<string, unknown>, method: string): void {
  expect({
    selector: request.selector,
    method: request.method,
    timeoutMs: request.timeoutMs
  }).toStrictEqual({ selector: 'env-1', method, timeoutMs: 15_000 })
}

beforeEach(() => {
  resetAgentBackgroundSessionTestHarness({
    state,
    createTab: mockCreateTab,
    closeTab: mockCloseTab,
    getLaunchPlatform: unusedLaunchPlatformMock,
    runtimeCall: mockRuntimeEnvironmentCall,
    runtimeTransportCall: mockRuntimeEnvironmentTransportCall,
    runtimeSubscribe: mockRuntimeEnvironmentSubscribe,
    subscribeToData: mockSubscribeToPtyData,
    subscribeToExit: mockSubscribeToPtyExit,
    setTabLayout: mockSetTabLayout,
    updateTabPtyId: mockUpdateTabPtyId,
    dispatchEvent: mockDispatchEvent,
    kill: mockKill,
    spawn: mockSpawn,
    write: mockWrite
  })
  useRemoteAgentBackgroundRuntime(state)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

beforeAll(async () => {
  await loadForClient('win32')
  await loadForClient('linux')
}, 120_000)

type HostAuthorityCase = {
  name: string
  agent: 'claude' | 'codex' | 'aider'
  keyboardNegotiated: boolean
  /** Prompt keys sent; stdin-after-start agents get theirs pasted after launch instead. */
  promptKeys: Record<string, unknown>
}

const HOST_AUTHORITY_CASES: HostAuthorityCase[] = [
  {
    name: 'claude prompt, keyboard negotiated',
    agent: 'claude',
    keyboardNegotiated: true,
    promptKeys: { prompt: PROMPT, promptDelivery: 'auto-submit' }
  },
  {
    name: 'claude prompt, keyboard not negotiated',
    agent: 'claude',
    keyboardNegotiated: false,
    promptKeys: { prompt: PROMPT, promptDelivery: 'auto-submit' }
  },
  {
    // The window plan's shell-ready delivery for codex is not sent; the host re-plans.
    name: 'codex prompt',
    agent: 'codex',
    keyboardNegotiated: true,
    promptKeys: { prompt: PROMPT, promptDelivery: 'auto-submit' }
  },
  {
    name: 'aider (stdin-after-start) sends no prompt',
    agent: 'aider',
    keyboardNegotiated: true,
    promptKeys: {}
  }
]

// Pins main's current launch behaviour as the convergence parity baseline (row 5r, host-authority path): the exact terminal.createAgentSession request an automation sends to a paired runtime.
describe('row 5r: host-authority terminal.createAgentSession params on main', () => {
  it.each(HOST_AUTHORITY_CASES)('$name', async (testCase) => {
    const { launch } = await loadForClient('linux')
    serveRuntimeStatusWithout(
      testCase.keyboardNegotiated ? [] : [AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY]
    )

    await launch.launchAgentBackgroundSession({
      agent: testCase.agent,
      worktreeId: 'wt-1',
      prompt: PROMPT,
      launchSource: 'unknown',
      title: 'Nightly audit'
    })

    expect(mockSpawn).not.toHaveBeenCalled()
    const request = onlyCreateRequest()
    const placement = request.params.placement
    expect(placement?.tabId).toMatch(UUID_RE)
    expect(placement?.leafId).toMatch(UUID_RE)
    // main today: no command, env, launchConfig, launchToken, title or agentArgs cross the wire.
    expectEnvelope(request, 'terminal.createAgentSession')
    expect(request.params).toStrictEqual({
      ...(testCase.keyboardNegotiated ? { terminalKittyKeyboardProtocol: true } : {}),
      worktree: 'id:wt-1',
      agent: testCase.agent,
      ...testCase.promptKeys,
      placement: { tabId: placement?.tabId, leafId: placement?.leafId },
      presentation: 'background',
      clientOperationId: expect.stringMatching(CLIENT_OPERATION_ID_RE)
    })
  })

  it('pastes the stdin-after-start prompt from the client after the host creates the terminal', async () => {
    const { launch } = await loadForClient('linux')
    serveRuntimeStatusWithout([])

    await launch.launchAgentBackgroundSession({
      agent: 'aider',
      worktreeId: 'wt-1',
      prompt: PROMPT
    })

    expect(mockPasteDraftWhenAgentReady).toHaveBeenCalledWith(
      expect.objectContaining({ content: PROMPT, agent: 'aider', submit: true })
    )
  })
})

type LegacyCase = {
  name: string
  client: Client
  agent: 'claude' | 'codex' | 'aider'
  title?: string
  command: string
  launchConfig: Record<string, unknown>
  /** Keys present only for some agents. */
  extra: Record<string, unknown>
}

const LEGACY_CASES: LegacyCase[] = [
  {
    name: 'claude with title (Linux client)',
    client: 'linux',
    agent: 'claude',
    title: 'Nightly audit',
    command: `claude '--dangerously-skip-permissions' ${POSIX_PROMPT}`,
    launchConfig: {
      agentCommand: "claude '--dangerously-skip-permissions'",
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    },
    extra: {}
  },
  {
    name: 'codex without title (Linux client)',
    client: 'linux',
    agent: 'codex',
    command: `codex '--dangerously-bypass-approvals-and-sandbox' ${POSIX_PROMPT}`,
    launchConfig: {
      agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
      agentArgs: '--dangerously-bypass-approvals-and-sandbox',
      agentEnv: {}
    },
    extra: { startupCommandDelivery: 'shell-ready' }
  },
  {
    name: 'aider, prompt kept off argv (Linux client)',
    client: 'linux',
    agent: 'aider',
    title: 'Nightly audit',
    command: "aider '--yes-always'",
    launchConfig: { agentCommand: "aider '--yes-always'", agentArgs: '--yes-always', agentEnv: {} },
    extra: {}
  },
  {
    // main today: the host runs a command quoted for the Windows client, even on a POSIX host path.
    name: 'claude from a Windows client to a POSIX host path',
    client: 'win32',
    agent: 'claude',
    title: 'Nightly audit',
    command: `claude '--dangerously-skip-permissions' 'don''t stop'`,
    launchConfig: {
      agentCommand: "claude '--dangerously-skip-permissions'",
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    },
    extra: {}
  }
]

// Pins main's current launch behaviour as the convergence parity baseline (row 5r, legacy path): the verbatim window plan terminal.create sends to a host without the agent-session host-authority capability.
describe('row 5r: legacy terminal.create params on main', () => {
  it.each(LEGACY_CASES)('$name', async (testCase) => {
    const { launch } = await loadForClient(testCase.client)
    state.repos = [{ id: 'repo-1', connectionId: null, path: '/srv/repo' }]
    state.worktreesByRepo['repo-1'][0].path = '/srv/repo/feature'
    // Keyboard support is also withheld: legacy kitty is the renderer option, never negotiated.
    serveRuntimeStatusWithout([
      AGENT_SESSION_HOST_AUTHORITY_CAPABILITY,
      AGENT_SESSION_KEYBOARD_RUNTIME_CAPABILITY
    ])

    await launch.launchAgentBackgroundSession({
      agent: testCase.agent,
      worktreeId: 'wt-1',
      prompt: PROMPT,
      launchSource: 'unknown',
      ...(testCase.title ? { title: testCase.title } : {})
    })

    expect(mockSpawn).not.toHaveBeenCalled()
    const request = onlyCreateRequest()
    const { tabId, leafId, launchToken } = request.params
    expect(tabId).toMatch(UUID_RE)
    expect(leafId).toMatch(UUID_RE)
    expect(launchToken).toMatch(UUID_RE)
    // No telemetry and no cwd: the host owns both on this path.
    expectEnvelope(request, 'terminal.create')
    expect(request.params).toStrictEqual({
      worktree: 'id:wt-1',
      command: testCase.command,
      terminalKittyKeyboardProtocol: true,
      ...testCase.extra,
      env: {
        ORCA_PANE_KEY: `${tabId}:${leafId}`,
        ORCA_TAB_ID: tabId,
        ORCA_WORKTREE_ID: 'wt-1',
        ORCA_AGENT_LAUNCH_TOKEN: launchToken
      },
      launchConfig: testCase.launchConfig,
      launchToken,
      launchAgent: testCase.agent,
      ...(testCase.title ? { title: testCase.title } : {}),
      tabId,
      leafId,
      presentation: 'background'
    })
  })

  it.each([['agent_session_legacy_required'], ['method_not_found']])(
    'falls back to terminal.create once the host answers %s',
    async (code) => {
      const { launch } = await loadForClient('linux')
      serveRuntimeStatusWithout([])
      mockRuntimeEnvironmentCall.mockImplementation((request: { method: string }) =>
        Promise.resolve(
          request.method === 'terminal.createAgentSession'
            ? { id: 'create', ok: false, error: { code, message: code } }
            : {
                ok: true,
                result: { terminal: { handle: 'legacy-1', worktreeId: 'wt-1', title: null } }
              }
        )
      )

      await expect(
        launch.launchAgentBackgroundSession({ agent: 'claude', worktreeId: 'wt-1', prompt: PROMPT })
      ).resolves.toMatchObject({ ptyId: 'remote:env-1@@legacy-1' })
      expect(
        rpcRequests()
          .map((request) => request.method)
          .slice(0, 2)
      ).toEqual(['terminal.createAgentSession', 'terminal.create'])
    }
  )
})
