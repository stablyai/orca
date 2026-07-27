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

  it('fails a local restore whose invoke never resolves instead of hanging', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue(null)
      // Why: models a wedged runtime/daemon after system sleep (#9447) — the
      // IPC invoke stays pending forever.
      restoreTerminalFit.mockReturnValue(new Promise(() => {}))

      let settled: boolean | null = null
      const pending = restoreTerminalFitToDesktop('pty-local', undefined).then((restored) => {
        settled = restored
      })
      await vi.advanceTimersByTimeAsync(14_999)
      expect(settled).toBeNull()
      await vi.advanceTimersByTimeAsync(1)
      await pending
      expect(settled).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives restores started later only the remainder of the shared bulk deadline', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue(null)
      restoreTerminalFit.mockImplementation(
        (ptyId: string) =>
          new Promise((resolve) => {
            if (ptyId === 'pty-0') {
              setTimeout(() => resolve({ restored: false }), 10_000)
            }
          })
      )
      const ptyIds = Array.from({ length: 100 }, (_, index) => `pty-${index}`)

      const pending = restoreTerminalFitsToDesktop(ptyIds, undefined)
      expect(restoreTerminalFit).toHaveBeenCalledTimes(8)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(restoreTerminalFit).toHaveBeenCalledTimes(9)
      await vi.advanceTimersByTimeAsync(4_999)
      let settled = false
      void pending.then(() => {
        settled = true
      })
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)

      await expect(pending).resolves.toBe(false)
      expect(restoreTerminalFit).toHaveBeenCalledTimes(9)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats failed remote RPC restore transport as not restored', async () => {
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue('terminal-fail')
    vi.mocked(getRemoteRuntimePtyEnvironmentId).mockReturnValue('env-fail')
    vi.mocked(callRuntimeRpc).mockRejectedValue(new Error('RPC failed'))

    await expect(restoreTerminalFitToDesktop('remote:pty-fail', undefined)).resolves.toBe(false)
  })

  it('bounds a remote restore even when the RPC client does not enforce its timeout', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue('terminal-stuck')
      vi.mocked(getRemoteRuntimePtyEnvironmentId).mockReturnValue('env-stuck')
      vi.mocked(callRuntimeRpc).mockReturnValue(new Promise(() => {}))

      const pending = restoreTerminalFitToDesktop('remote:pty-stuck', undefined)
      await vi.advanceTimersByTimeAsync(15_000)

      await expect(pending).resolves.toBe(false)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
