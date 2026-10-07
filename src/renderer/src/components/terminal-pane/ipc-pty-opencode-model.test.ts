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

  it('calibrates the host model during OpenCode creation before attaching to its result', async () => {
    const terminalImageCellSize = { width: 9.025, height: 18 }
    await spawnIpcPty(options(), { ...connect, terminalImageCellSize })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'local' },
      'terminal.createAgentSession',
      expect.objectContaining({ terminalImageCellSize })
    )
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'pty_host', terminalImageCellSize })
    )
  })
})
