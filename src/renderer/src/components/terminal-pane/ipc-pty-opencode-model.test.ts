import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { spawnIpcPty } from './ipc-pty-spawn-request'
import type { IpcPtyTransportOptions } from './pty-transport-types'

vi.mock('../../runtime/runtime-rpc-client', async () => ({
  callRuntimeRpc: vi.fn(),
  RuntimeRpcCallError: (await import('../../runtime/runtime-rpc-result')).RuntimeRpcCallError
}))
const spawn = vi.fn(async () => ({ id: 'pty_host', isReattach: true }))
const options = (): IpcPtyTransportOptions => ({
  worktreeId: 'folder:private',
  tabId: 'tab_private',
  leafId: 'leaf_private',
  launchAgent: 'opencode',
  command: 'opencode --model private-proof/model-b',
  agentPrompt: 'Read only',
  agentPromptDelivery: 'auto-submit',
  agentLaunchPreferences: { model: 'private-proof/model-b' }
})
const connect = { url: 'ipc://private', callbacks: {}, cols: 80, rows: 24 }

describe('local OpenCode model launch authority', () => {
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

  it('sends preferences to the execution host and attaches only to its returned PTY', async () => {
    const claimReplacedPtyId = vi.fn(() => 'pty_previous')
    expect(await spawnIpcPty(options(), { ...connect, claimReplacedPtyId })).toMatchObject({
      id: 'pty_host'
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.createAgentSession',
      expect.objectContaining({
        agent: 'opencode',
        launchPreferences: { model: 'private-proof/model-b' },
        prompt: 'Read only',
        promptDelivery: 'auto-submit',
        placement: { tabId: 'tab_private', leafId: 'leaf_private' }
      })
    )
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty_host', command: undefined })
    )
    expect(claimReplacedPtyId).not.toHaveBeenCalled()
  })

  it('preserves one operation ID across a lost reply and reconnect', async () => {
    const transport = options()
    vi.mocked(callRuntimeRpc).mockRejectedValueOnce(new Error('reply lost'))
    await spawnIpcPty(transport, connect)
    await spawnIpcPty(transport, connect)
    const operationRequest = z.object({ clientOperationId: z.string() })
    const ids = vi
      .mocked(callRuntimeRpc)
      .mock.calls.map((call) => operationRequest.parse(call[2]).clientOperationId)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(1)
    expect(ids[0]).toMatch(/^\d{13}-[0-9a-f]{32}$/)
  })

  it('does not issue raw spawn or replacement effects after the host refuses', async () => {
    vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('capability_unsupported'))
    const claimReplacedPtyId = vi.fn(() => 'pty_previous')
    await expect(spawnIpcPty(options(), { ...connect, claimReplacedPtyId })).rejects.toThrow(
      'capability_unsupported'
    )
    expect(spawn).not.toHaveBeenCalled()
    expect(claimReplacedPtyId).not.toHaveBeenCalled()
  })

  it.each([
    { connectionId: 'ssh_private' },
    { resumeProviderSession: { key: 'session_id' as const, id: 'old' } }
  ])('refuses unsupported placement before host or raw spawn', async (extra) => {
    await expect(spawnIpcPty({ ...options(), ...extra }, connect)).rejects.toThrow(
      'capability_unsupported'
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('preserves ordinary raw startup and captured-session attachment', async () => {
    const ordinary = { ...options(), agentLaunchPreferences: undefined }
    await spawnIpcPty(ordinary, connect)
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ command: ordinary.command }))
    await spawnIpcPty(options(), connect, 'pty_existing')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(spawn).toHaveBeenLastCalledWith(expect.objectContaining({ sessionId: 'pty_existing' }))
  })
})

const HOST_RUNTIME = {
  status: 'resolved',
  runtime: {
    kind: 'windows-host',
    hostPlatform: 'win32',
    projectId: 'repo-1',
    reason: 'global-default',
    cacheKey: 'repo-1:windows-host'
  }
} as const
const PANE_ENV = { ORCA_PANE_KEY: 'tab-1:leaf-1', ORCA_AGENT_LAUNCH_TOKEN: 'tok-1' }
const TELEMETRY = {
  agent_kind: 'opencode',
  launch_source: 'new_workspace_composer',
  request_kind: 'new'
} as const
// A macOS pane advertises kitty; a local Windows ConPTY pane withholds it and sends its shell.
const PANES = [
  { name: 'macOS', cwd: '/home/alice/repo', kitty: true, shell: {} },
  {
    name: 'Windows C:',
    cwd: String.raw`C:\Users\alice\repo`,
    kitty: false,
    shell: { shellOverride: 'powershell.exe', projectRuntime: HOST_RUNTIME }
  }
] as const

/** A pane seeded with an OpenCode model pick (worktree-initial-terminal-seeding.ts): its startup
 *  queues sessionOptions, never an args override, and the composer sent no prompt. */
const modelPane = (pane: (typeof PANES)[number]): IpcPtyTransportOptions => ({
  worktreeId: `repo-1::${pane.cwd}`,
  tabId: 'tab-1',
  leafId: 'leaf-1',
  cwd: pane.cwd,
  cwdFallback: 'worktree',
  env: PANE_ENV,
  command: 'opencode',
  launchConfig: { agentCommand: 'opencode', agentArgs: '', agentEnv: {} },
  launchToken: 'tok-1',
  launchAgent: 'opencode',
  agentLaunchPreferences: { model: 'private-proof/model-b' },
  ...pane.shell,
  terminalKittyKeyboardProtocol: pane.kitty,
  telemetry: TELEMETRY
})

// Pins main's current launch behaviour as the convergence parity baseline (row 4, window half):
// the exact host request (the main suite's OpenCode cases run it) and reattach a model-pick pane sends.
describe('row 4: OpenCode model pane requests on main', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.stubGlobal('window', { api: { pty: { spawn } } })
    spawn.mockResolvedValue({ id: 'pty_host', isReattach: true })
    vi.mocked(callRuntimeRpc).mockResolvedValue({ terminal: { ptyId: 'pty_host' } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it.each(PANES)('$name pane: one exact createAgentSession, then a reattach', async (pane) => {
    await spawnIpcPty(modelPane(pane), { ...connect, initiallyHidden: true })

    // The host gets the pick and cwd but none of the pane's command, env, shell or telemetry.
    expect(vi.mocked(callRuntimeRpc).mock.calls).toEqual([
      [
        { kind: 'local' },
        'terminal.createAgentSession',
        {
          clientOperationId: expect.stringMatching(/^\d{13}-[0-9a-f]{32}$/),
          worktree: `id:repo-1::${pane.cwd}`,
          agent: 'opencode',
          launchPreferences: { model: 'private-proof/model-b' },
          startupCwd: pane.cwd,
          placement: { tabId: 'tab-1', leafId: 'leaf-1' },
          presentation: 'background',
          ...(pane.kitty ? { terminalKittyKeyboardProtocol: true } : {})
        }
      ]
    ])
    // main today: the reattach keeps telemetry, shell, runtime and the hidden flag, and drops
    // command, launchConfig and cwdFallback.
    expect(spawn.mock.calls).toEqual([
      [
        {
          cols: 80,
          rows: 24,
          cwd: pane.cwd,
          env: PANE_ENV,
          command: undefined,
          launchToken: 'tok-1',
          launchAgent: 'opencode',
          sessionId: 'pty_host',
          worktreeId: `repo-1::${pane.cwd}`,
          tabId: 'tab-1',
          leafId: 'leaf-1',
          initiallyHidden: true,
          ...pane.shell,
          ...(pane.kitty ? { terminalKittyKeyboardProtocol: true } : {}),
          telemetry: TELEMETRY
        }
      ]
    ])
  })
})
