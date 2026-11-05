import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/runtime-terminal-stream'
import { restoreTerminalFitToDesktop, restoreTerminalFitsToDesktop } from './terminal-fit-restore'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn() }))

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

  it('fails a local restore whose invoke never resolves instead of hanging', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue(null)
      // Model sleep-wedged runtime/daemon IPC that never resolves (#9447).
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
