import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'
import { restoreTerminalFitToDesktop, restoreTerminalFitsToDesktop } from './terminal-fit-restore'

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/runtime-terminal-stream', () => ({
  getRemoteRuntimePtyEnvironmentId: vi.fn(),
  getRemoteRuntimeTerminalHandle: vi.fn()
}))

const restoreTerminalFit = vi.fn()

describe('terminal-fit-restore', () => {
  beforeEach(() => {
    restoreTerminalFit.mockReset()
    vi.mocked(callRuntimeRpc).mockReset()
    vi.mocked(getRemoteRuntimePtyEnvironmentId).mockReset()
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReset()
    vi.stubGlobal('window', {
      api: {
        runtime: {
          restoreTerminalFit
        }
      }
    })
  })

  it('restores local terminals through desktop IPC', async () => {
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue(null)
    restoreTerminalFit.mockResolvedValue({ restored: true })

    await expect(
      restoreTerminalFitToDesktop('pty-local', { activeRuntimeEnvironmentId: 'env-unused' })
    ).resolves.toBe(true)

    expect(restoreTerminalFit).toHaveBeenCalledWith('pty-local')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('restores remote terminals through the environment runtime RPC', async () => {
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue('terminal-one')
    vi.mocked(getRemoteRuntimePtyEnvironmentId).mockReturnValue('env-one')
    vi.mocked(callRuntimeRpc).mockResolvedValue({ restored: true })

    await expect(restoreTerminalFitToDesktop('remote:pty-1', undefined)).resolves.toBe(true)

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-one' },
      'terminal.restoreFit',
      { terminal: 'terminal-one' },
      { timeoutMs: 15_000 }
    )
    expect(restoreTerminalFit).not.toHaveBeenCalled()
  })

  it('uses the active runtime environment when the remote PTY has no encoded environment', async () => {
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue('terminal-two')
    vi.mocked(getRemoteRuntimePtyEnvironmentId).mockReturnValue(null)
    vi.mocked(callRuntimeRpc).mockResolvedValue({ restored: true })

    await expect(
      restoreTerminalFitToDesktop('remote:pty-2', { activeRuntimeEnvironmentId: 'env-active' })
    ).resolves.toBe(true)

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-active' },
      'terminal.restoreFit',
      { terminal: 'terminal-two' },
      { timeoutMs: 15_000 }
    )
  })

  it('deduplicates bulk restore PTYs and succeeds when any restore succeeds', async () => {
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue(null)
    restoreTerminalFit.mockImplementation(async (ptyId: string) => ({
      restored: ptyId === 'pty-2'
    }))

    await expect(
      restoreTerminalFitsToDesktop(['pty-1', 'pty-1', 'pty-2'], undefined)
    ).resolves.toBe(true)

    expect(restoreTerminalFit).toHaveBeenCalledTimes(2)
    expect(restoreTerminalFit).toHaveBeenNthCalledWith(1, 'pty-1')
    expect(restoreTerminalFit).toHaveBeenNthCalledWith(2, 'pty-2')
  })

  it('treats failed local restore transport as not restored', async () => {
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue(null)
    restoreTerminalFit.mockRejectedValue(new Error('restore failed'))

    await expect(restoreTerminalFitToDesktop('pty-local', undefined)).resolves.toBe(false)
  })

  it('treats failed remote RPC restore transport as not restored', async () => {
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue('terminal-fail')
    vi.mocked(getRemoteRuntimePtyEnvironmentId).mockReturnValue('env-fail')
    vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('RPC failed'))

    await expect(restoreTerminalFitToDesktop('remote:pty-fail', undefined)).resolves.toBe(false)
  })
})
