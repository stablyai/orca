import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'

const callRuntimeRpc = vi.hoisted(() =>
  vi.fn<(target: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>>()
)
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc
}))

const { spawnBackgroundRunPty } = await import('./background-run-host-spawn')
const { CLIENT_PLATFORM } = await import('@/lib/new-workspace')
const OTHER_PLATFORM: NodeJS.Platform = CLIENT_PLATFORM === 'win32' ? 'linux' : 'win32'

const ptySpawn = vi.fn()
const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const WINDOW_SPAWN = {
  cols: 120,
  rows: 40,
  cwd: '/tmp/feature',
  command: "claude 'Review the diff'",
  env: { ORCA_PANE_KEY: `${TAB_ID}:${LEAF_ID}` },
  launchToken: 'token-1',
  launchAgent: 'claude' as const,
  connectionId: null,
  worktreeId: 'repo1::/tmp/feature',
  tabId: TAB_ID,
  leafId: LEAF_ID,
  placement: { kind: 'new-tab' as const, row: { customTitle: 'Nightly' } }
}

function run(overrides: Partial<Parameters<typeof spawnBackgroundRunPty>[0]> = {}) {
  return spawnBackgroundRunPty({
    spawn: WINDOW_SPAWN,
    agent: 'claude',
    worktreeId: 'repo1::/tmp/feature',
    commandPrompt: 'Review the diff',
    extraAgentArgs: '--effort high',
    title: 'Nightly',
    launchSource: 'unknown',
    launchPlatform: CLIENT_PLATFORM,
    ...overrides
  })
}

function rpcError(code: string, message = code): RuntimeRpcCallError {
  return new RuntimeRpcCallError({
    id: 'desktop-ipc',
    ok: false,
    error: { code, message },
    _meta: { runtimeId: 'runtime-1' }
  })
}

const HOST_RESULT = {
  outcome: { kind: 'terminal', handle: 'term_1', paneKey: `${TAB_ID}:${LEAF_ID}` },
  worktreeId: 'repo1::/tmp/feature',
  receipt: { mode: 'terminal', preferred: 'terminal', reason: 'user_default', detail: 'x' },
  backgroundRun: { ptyId: 'pty-1', incarnationId: 'inc-1' }
}

beforeEach(() => {
  callRuntimeRpc.mockReset()
  ptySpawn.mockReset().mockResolvedValue({ id: 'pty-window' })
  vi.stubGlobal('window', { api: { pty: { spawn: ptySpawn } } })
})

describe("a desktop automation run's spawn", () => {
  it("asks this window's host to start it, and adopts the PTY the host spawned", async () => {
    callRuntimeRpc.mockResolvedValue(HOST_RESULT)

    await expect(run()).resolves.toEqual({ id: 'pty-1', incarnationId: 'inc-1' })

    expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'agent.launch', {
      agent: 'claude',
      target: { kind: 'existing', worktree: 'id:repo1::/tmp/feature' },
      prompt: { text: 'Review the diff', delivery: 'submit' },
      launchSource: 'unknown',
      paneKey: `${TAB_ID}:${LEAF_ID}`,
      presentation: 'background',
      backgroundRun: { title: 'Nightly', extraAgentArgs: '--effort high', launchToken: 'token-1' }
    })
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('sends no prompt for an agent that reads it after start', async () => {
    callRuntimeRpc.mockResolvedValue(HOST_RESULT)

    await run({ agent: 'aider', commandPrompt: undefined })

    expect(callRuntimeRpc.mock.calls[0]?.[2]).not.toHaveProperty('prompt')
  })

  it.each<[string, Partial<Parameters<typeof spawnBackgroundRunPty>[0]>]>([
    ['an SSH workspace', { spawn: { ...WINDOW_SPAWN, connectionId: 'ssh-1' } }],
    ['a launch planned for another platform', { launchPlatform: OTHER_PLATFORM }]
  ])('keeps the window spawn for %s', async (_name, overrides) => {
    await expect(run(overrides)).resolves.toEqual({ id: 'pty-window' })

    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(ptySpawn).toHaveBeenCalledWith(overrides.spawn ?? WINDOW_SPAWN)
  })

  it('makes the window spawn when the host refused before spawning', async () => {
    callRuntimeRpc.mockRejectedValue(rpcError('agent_launch_background_run_unavailable'))

    await expect(run()).resolves.toEqual({ id: 'pty-window' })

    expect(ptySpawn).toHaveBeenCalledWith(WINDOW_SPAWN)
  })

  it("fails as main's spawn failed when the host's spawn failed, without spawning again", async () => {
    callRuntimeRpc.mockRejectedValue(
      rpcError('agent_launch_background_run_spawn_failed', 'Error: posix_spawnp failed.')
    )

    await expect(run()).rejects.toThrow(
      "Error invoking remote method 'pty:spawn': Error: posix_spawnp failed."
    )
    expect(ptySpawn).not.toHaveBeenCalled()
  })

  it('never spawns again after any other failure, which may have started the agent', async () => {
    callRuntimeRpc.mockRejectedValue(rpcError('runtime_error', 'lost'))

    await expect(run()).rejects.toThrow('lost')
    expect(ptySpawn).not.toHaveBeenCalled()
  })
})
