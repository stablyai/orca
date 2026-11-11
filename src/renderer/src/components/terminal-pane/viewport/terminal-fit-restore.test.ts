import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  getRemoteRuntimePtyEnvironmentId,
  getRemoteRuntimeTerminalHandle
} from '@/runtime/hosted-terminals/identity/remote-runtime-pty-owner'
import { setDriverForBrowserPage } from '@/lib/pane-manager/browser-mobile-driver-state'
import { hydrateDrivers } from '@/lib/pane-manager/mobile-driver-state'
import { setFitOverride } from '@/lib/pane-manager/mobile-fit-overrides'
import {
  registerLivePaneManager,
  registerLivePanePtySizeReasserter,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'
import {
  reclaimAllMobileSurfacesToDesktop,
  restoreTerminalFitToDesktop,
  restoreTerminalFitsToDesktop,
  scheduleRestoredTerminalRefit
} from './terminal-fit-restore'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn()
}))

vi.mock('@/runtime/hosted-terminals/identity/remote-runtime-pty-owner', () => ({
  getRemoteRuntimePtyEnvironmentId: vi.fn(),
  getRemoteRuntimeTerminalHandle: vi.fn()
}))

const restoreTerminalFit = vi.fn()
const reclaimBrowserForDesktop = vi.fn()

describe('terminal-fit-restore', () => {
  beforeEach(() => {
    restoreTerminalFit.mockReset()
    reclaimBrowserForDesktop.mockReset()
    hydrateDrivers([])
    setFitOverride('pty-agent', 'desktop-fit', 0, 0)
    setDriverForBrowserPage('browser-page-1', { kind: 'idle' })
    setDriverForBrowserPage('browser-page-2', { kind: 'idle' })
    vi.mocked(callRuntimeRpc).mockReset()
    vi.mocked(getRemoteRuntimePtyEnvironmentId).mockReset()
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReset()
    vi.stubGlobal('window', {
      api: {
        runtime: {
          restoreTerminalFit,
          reclaimBrowserForDesktop
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

  it('reclaims both held/split mobile terminals and mobile-driven browser pages together', async () => {
    vi.mocked(getRemoteRuntimeTerminalHandle).mockReturnValue(null)
    setFitOverride('pty-agent', 'mobile-fit', 48, 24)
    hydrateDrivers([{ ptyId: 'pty-shell-split', driver: { kind: 'mobile', clientId: 'phone-1' } }])
    setDriverForBrowserPage('browser-page-1', { kind: 'mobile', clientId: 'phone-1' })

    restoreTerminalFit.mockResolvedValue({ restored: true })
    reclaimBrowserForDesktop.mockResolvedValue({ reclaimed: true })

    const outcome = await reclaimAllMobileSurfacesToDesktop(undefined, ['browser-page-2'])

    expect(outcome).toEqual({
      restored: true,
      hadTargets: true,
      restoredTerminals: true,
      reclaimedBrowsers: true
    })
    expect(restoreTerminalFit).toHaveBeenCalledTimes(2)
    expect(restoreTerminalFit).toHaveBeenCalledWith('pty-agent')
    expect(restoreTerminalFit).toHaveBeenCalledWith('pty-shell-split')
    expect(reclaimBrowserForDesktop).toHaveBeenCalledTimes(2)
    expect(reclaimBrowserForDesktop).toHaveBeenCalledWith('browser-page-1')
    expect(reclaimBrowserForDesktop).toHaveBeenCalledWith('browser-page-2')
  })

  it('reasserts terminal PTY sizes after main resize-suppression expires on restore refit', async () => {
    vi.useFakeTimers()
    const fitAllPanes = vi.fn()
    const refreshAllPanes = vi.fn()
    const reassertPtySize = vi.fn()
    const manager = {
      resetWebglTextureAtlases: vi.fn(),
      fitAllPanes,
      refreshAllPanes
    }
    const rafCallbacks: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCallbacks.push(cb)
      return rafCallbacks.length
    })
    registerLivePaneManager(manager)
    const unregisterReasserter = registerLivePanePtySizeReasserter(reassertPtySize)

    try {
      scheduleRestoredTerminalRefit()
      for (const cb of rafCallbacks) {
        cb(16)
      }
      expect(fitAllPanes).toHaveBeenCalledTimes(1)
      expect(reassertPtySize).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(100)
      expect(fitAllPanes).toHaveBeenCalledTimes(2)
      expect(reassertPtySize).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(450)
      expect(fitAllPanes).toHaveBeenCalledTimes(3)
      expect(reassertPtySize).toHaveBeenCalledTimes(1)
    } finally {
      unregisterReasserter()
      unregisterLivePaneManager(manager)
      vi.useRealTimers()
    }
  })
})
