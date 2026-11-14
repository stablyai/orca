import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'zod'
import { callRuntimeRpc } from '../../../../runtime/rpc/calls/runtime-rpc-call'
import { spawnIpcPty } from './ipc-pty-spawn-request'
import type { IpcPtyTransportOptions } from '../pty-transport-types'

vi.mock('../../../../runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn()
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
})
