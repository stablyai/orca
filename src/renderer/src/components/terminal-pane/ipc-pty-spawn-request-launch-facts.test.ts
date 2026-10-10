import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { spawnIpcPty } from './ipc-pty-spawn-request'
import type { IpcPtyTransportOptions } from './pty-transport-types'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'

vi.mock('../../runtime/runtime-rpc-client', async () => ({
  callRuntimeRpc: vi.fn(),
  RuntimeRpcCallError: (await import('../../runtime/runtime-rpc-result')).RuntimeRpcCallError
}))
const spawn = vi.fn(async () => ({ id: 'pty_host', isReattach: true }))
const connect = { url: 'ipc://pane', callbacks: {}, cols: 132, rows: 41 }
const OPERATION_ID = expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/)

const WSL_RUNTIME: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
}
const PANE_ENV = {
  ORCA_WORKSPACE_ID: 'repo-1::/r/wt',
  ORCA_PANE_KEY: 'tab-1:leaf-1',
  ORCA_TAB_ID: 'tab-1',
  ORCA_WORKTREE_ID: 'repo-1::/r/wt',
  ORCA_AGENT_LAUNCH_TOKEN: 'tok-1'
}
const TELEMETRY = {
  agent_kind: 'opencode',
  launch_source: 'tab_bar_quick_launch',
  request_kind: 'new'
} as const

/** The transport options a local OpenCode pane with a model preference builds (row 4). */
function modelPane(extra: Partial<IpcPtyTransportOptions> = {}): IpcPtyTransportOptions {
  return {
    worktreeId: 'repo-1::/r/wt',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    cwd: '/r/wt/packages/app',
    cwdFallback: 'worktree',
    env: PANE_ENV,
    command: "opencode --model 'acme/model-b' --prompt 'Read only'",
    launchConfig: { agentCommand: 'opencode', agentArgs: '--pure', agentEnv: {} },
    launchToken: 'tok-1',
    launchAgent: 'opencode',
    agentPrompt: 'Read only',
    agentPromptDelivery: 'draft',
    agentArgsOverride: '--pure',
    agentLaunchPreferences: { model: 'acme/model-b' },
    placement: { kind: 'new-tab' },
    shellOverride: 'wsl.exe',
    projectRuntime: WSL_RUNTIME,
    terminalColorQueryReplies: { foreground: '#ffffff', background: '#000000' },
    telemetry: TELEMETRY,
    ...extra
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('window', { api: { pty: { spawn } } })
  spawn.mockResolvedValue({ id: 'pty_host', isReattach: true })
  vi.mocked(callRuntimeRpc).mockResolvedValue({
    terminal: { ptyId: 'pty_host' },
    disposition: 'created'
  })
})
afterEach(() => vi.unstubAllGlobals())

// Pins main's current launch behaviour as the convergence parity baseline (row 4): the exact host request and reattach an OpenCode pane with a model preference sends.
describe('row 4: OpenCode model pane host lane on main', () => {
  it.each([
    {
      name: 'kitty keyboard on',
      kitty: true,
      expectKitty: { terminalKittyKeyboardProtocol: true }
    },
    { name: 'kitty keyboard off', kitty: false, expectKitty: {} }
  ])('sends one exact terminal.createAgentSession, $name', async ({ kitty, expectKitty }) => {
    const claimReplacedPtyId = vi.fn(() => 'pty_previous')
    await spawnIpcPty(modelPane({ terminalKittyKeyboardProtocol: kitty }), {
      ...connect,
      claimReplacedPtyId
    })

    // The host gets prompt, args and cwd but none of the pane's command, env, shell or telemetry.
    expect(vi.mocked(callRuntimeRpc).mock.calls).toEqual([
      [
        { kind: 'local' },
        'terminal.createAgentSession',
        {
          clientOperationId: OPERATION_ID,
          worktree: 'id:repo-1::/r/wt',
          agent: 'opencode',
          prompt: 'Read only',
          promptDelivery: 'draft',
          agentArgs: '--pure',
          launchPreferences: { model: 'acme/model-b' },
          startupCwd: '/r/wt/packages/app',
          placement: { tabId: 'tab-1', leafId: 'leaf-1' },
          presentation: 'background',
          ...expectKitty
        }
      ]
    ])
    // main today: the reattach still sends telemetry, shellOverride and projectRuntime, and drops
    // command, launchConfig, cwdFallback and placement; it never claims the replaced PTY.
    expect(spawn.mock.calls).toStrictEqual([
      [
        {
          cols: 132,
          rows: 41,
          cwd: '/r/wt/packages/app',
          env: PANE_ENV,
          command: undefined,
          launchToken: 'tok-1',
          launchAgent: 'opencode',
          sessionId: 'pty_host',
          worktreeId: 'repo-1::/r/wt',
          tabId: 'tab-1',
          leafId: 'leaf-1',
          shellOverride: 'wsl.exe',
          projectRuntime: WSL_RUNTIME,
          terminalColorQueryReplies: { foreground: '#ffffff', background: '#000000' },
          ...(kitty ? { terminalKittyKeyboardProtocol: true } : {}),
          telemetry: TELEMETRY
        }
      ]
    ])
    expect(claimReplacedPtyId).not.toHaveBeenCalled()
  })

  it('keeps the initially-hidden declaration on the reattach', async () => {
    await spawnIpcPty(modelPane(), { ...connect, initiallyHidden: true })
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ sessionId: 'pty_host', initiallyHidden: true })
    )
  })

  it.each([
    { name: 'no worktreeId', extra: { worktreeId: undefined } },
    { name: 'no tabId', extra: { tabId: undefined } },
    { name: 'no leafId', extra: { leafId: undefined } },
    { name: 'SSH pane', extra: { connectionId: 'ssh-1' } }
  ])('refuses $name before any host call or raw spawn', async ({ extra }) => {
    await expect(spawnIpcPty(modelPane(extra), connect)).rejects.toThrow('capability_unsupported')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('takes the raw window lane when every preference value is undefined', async () => {
    await spawnIpcPty(modelPane({ agentLaunchPreferences: { model: undefined } }), connect)
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        command: "opencode --model 'acme/model-b' --prompt 'Read only'",
        cwdFallback: 'worktree',
        placement: { kind: 'new-tab' }
      })
    )
  })
})

/** What a typed-prompt or reference pane builds for its window-lane spawn (rows 1, 2, 6). */
const WINDOW_LAUNCH_CONFIG = {
  agentCommand: "claude '--dangerously-skip-permissions'",
  agentArgs: '--dangerously-skip-permissions',
  agentEnv: {}
}

// Pins main's current launch behaviour as the convergence parity baseline (rows 1, 2, 6): the exact pty:spawn request a window pane sends from its transport options.
describe('rows 1/2/6: window-pane pty:spawn request on main', () => {
  it.each([
    {
      name: 'local pane keeps the worktree cwd fallback',
      options: {
        worktreeId: 'repo-1::/r/wt',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        cwd: '/r/wt',
        cwdFallback: 'worktree',
        env: PANE_ENV,
        command: "claude '--dangerously-skip-permissions' --prefill 'hi'",
        launchConfig: WINDOW_LAUNCH_CONFIG,
        launchToken: 'tok-1',
        launchAgent: 'claude',
        telemetry: {
          agent_kind: 'claude-code',
          launch_source: 'quick_command',
          request_kind: 'new'
        }
      },
      expected: {
        cwd: '/r/wt',
        cwdFallback: 'worktree',
        env: PANE_ENV,
        command: "claude '--dangerously-skip-permissions' --prefill 'hi'",
        launchConfig: WINDOW_LAUNCH_CONFIG,
        launchToken: 'tok-1',
        launchAgent: 'claude',
        worktreeId: 'repo-1::/r/wt',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        telemetry: {
          agent_kind: 'claude-code',
          launch_source: 'quick_command',
          request_kind: 'new'
        }
      }
    },
    {
      // SSH keeps the exact cwd (no fallback) and hands startup delivery to the provider.
      name: 'SSH pane delegates startup delivery to the provider',
      options: {
        worktreeId: 'repo-1::/home/u/r',
        tabId: 'tab-1',
        leafId: 'leaf-1',
        cwd: '/home/u/r',
        cwdFallback: 'worktree',
        env: PANE_ENV,
        command: "codex 'fix it'",
        commandDelivery: 'provider',
        startupCommandDelivery: 'shell-ready',
        connectionId: 'ssh-1',
        launchAgent: 'codex'
      },
      expected: {
        cwd: '/home/u/r',
        env: PANE_ENV,
        command: "codex 'fix it'",
        commandDelivery: 'provider',
        launchAgent: 'codex',
        startupCommandDelivery: 'shell-ready',
        connectionId: 'ssh-1',
        worktreeId: 'repo-1::/home/u/r',
        tabId: 'tab-1',
        leafId: 'leaf-1'
      }
    }
  ] satisfies { name: string; options: IpcPtyTransportOptions; expected: object }[])(
    '$name',
    async ({ options, expected }) => {
      await spawnIpcPty(options, { url: '', callbacks: {}, cols: 120, rows: 40 })
      expect(spawn.mock.calls).toEqual([[{ cols: 120, rows: 40, ...expected }]])

      spawn.mockClear()
      await spawnIpcPty(options, { url: '', callbacks: {} })
      expect(spawn.mock.calls).toEqual([[{ cols: 80, rows: 24, ...expected }]])
    }
  )
})
