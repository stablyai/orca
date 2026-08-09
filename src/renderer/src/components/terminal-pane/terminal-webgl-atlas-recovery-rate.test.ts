import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  registerLivePaneManager,
  unregisterLivePaneManager
} from '@/lib/pane-manager/pane-manager-registry'
import { setTerminalWebglDiagnosticRecorder } from '../../../../shared/terminal-webgl-diagnostics'
import {
  resetTerminalWebglAtlasRecoveryBudgetForTesting,
  scheduleImagePasteWebglAtlasRecovery,
  scheduleTabRevealWebglAtlasRecovery,
  scheduleTerminalWebglAtlasRecovery,
  TERMINAL_OUTPUT_RECOVERY_QUIET_MS
} from './terminal-webgl-atlas-recovery'

describe('terminal WebGL atlas recovery rate', () => {
  const managers: { resetWebglTextureAtlases(): void }[] = []

  function registerManager() {
    const manager = {
      resetWebglTextureAtlases: vi.fn(),
      refreshAllPanes: vi.fn(),
      scheduleRevealPresent: vi.fn()
    }
    registerLivePaneManager(manager)
    managers.push(manager)
    return manager
  }

  function useImmediateAnimationFrames(): void {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        callback(0)
        return 1
      })
    )
  }

  afterEach(() => {
    for (const manager of managers.splice(0)) {
      unregisterLivePaneManager(manager)
    }
    setTerminalWebglDiagnosticRecorder(null)
    resetTerminalWebglAtlasRecoveryBudgetForTesting()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('caps atlas wipes under a sustained redraw cadence', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    useImmediateAnimationFrames()
    const wipeTimes: number[] = []
    const manager = {
      resetWebglTextureAtlases: vi.fn(() => wipeTimes.push(Date.now())),
      refreshAllPanes: vi.fn(),
      scheduleRevealPresent: vi.fn()
    }
    registerLivePaneManager(manager)
    managers.push(manager)

    for (let elapsed = 0; elapsed < 300_000; elapsed += 300) {
      scheduleTerminalWebglAtlasRecovery()
      vi.advanceTimersByTime(300)
    }

    expect(wipeTimes.length).toBeGreaterThan(1)
    const gaps = wipeTimes.slice(1).map((at, index) => at - wipeTimes[index]!)
    expect(wipeTimes.length).toBeLessThanOrEqual(75)
    expect(Math.max(...gaps)).toBeLessThanOrEqual(6_500)
    expect(Date.now() - wipeTimes.at(-1)!).toBeLessThanOrEqual(6_500)

    const streamEndedAt = Date.now()
    const wipesBeforeTailRepair = wipeTimes.length
    vi.advanceTimersByTime(6_500)
    expect(wipeTimes).toHaveLength(wipesBeforeTailRepair + 1)
    expect(wipeTimes.at(-1)! - streamEndedAt).toBeLessThanOrEqual(6_500)
  })

  it('cancels pending settle and deferred repair timers when recovery state resets', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    useImmediateAnimationFrames()
    const manager = registerManager()

    scheduleTerminalWebglAtlasRecovery()
    resetTerminalWebglAtlasRecoveryBudgetForTesting()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)

    expect(manager.resetWebglTextureAtlases).not.toHaveBeenCalled()
    expect(manager.scheduleRevealPresent).not.toHaveBeenCalled()

    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    resetTerminalWebglAtlasRecoveryBudgetForTesting()
    vi.advanceTimersByTime(3_000)

    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledOnce()
    expect(manager.scheduleRevealPresent).toHaveBeenCalledOnce()
  })

  it('presents a suppressed wipe and cancels its repair while output resumes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    useImmediateAnimationFrames()
    const manager = registerManager()

    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)

    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledOnce()
    expect(manager.scheduleRevealPresent).toHaveBeenCalledOnce()

    for (let elapsed = 0; elapsed < 3_000; elapsed += 50) {
      scheduleTerminalWebglAtlasRecovery()
      vi.advanceTimersByTime(50)
    }
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledOnce()

    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(2)
  })

  it('repairs the final suppressed settle when the budget becomes available', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    useImmediateAnimationFrames()
    const manager = registerManager()

    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    vi.advanceTimersByTime(2_799)

    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(1)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(2)
  })

  it('reports suppressed reset counts on the next permitted wipe', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    useImmediateAnimationFrames()
    registerManager()
    const diagnostics: { kind: string; detail?: Record<string, unknown> }[] = []
    setTerminalWebglDiagnosticRecorder((kind, detail) => diagnostics.push({ kind, detail }))

    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    vi.advanceTimersByTime(2_600)
    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)

    expect(diagnostics.filter(({ kind }) => kind === 'webgl-atlas-reset-rate')).toEqual([
      {
        kind: 'webgl-atlas-reset-rate',
        detail: {
          reason: 'terminal-output',
          attemptsSinceLastReset: 1,
          atlasResetsSuppressed: 0,
          intervalMs: 0
        }
      },
      {
        kind: 'webgl-atlas-reset-rate',
        detail: {
          reason: 'terminal-output',
          attemptsSinceLastReset: 2,
          atlasResetsSuppressed: 1,
          intervalMs: 3_000
        }
      }
    ])
  })

  it('recovers when the wall clock steps backwards', () => {
    vi.useFakeTimers()
    vi.setSystemTime(600_000)
    useImmediateAnimationFrames()
    const manager = registerManager()

    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    vi.setSystemTime(60_000)
    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)

    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(2)
  })

  it('keeps one-shot paste and reveal recovery outside the streaming budget', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    useImmediateAnimationFrames()
    const manager = registerManager()

    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    scheduleTerminalWebglAtlasRecovery()
    vi.advanceTimersByTime(TERMINAL_OUTPUT_RECOVERY_QUIET_MS)
    manager.resetWebglTextureAtlases.mockClear()

    scheduleTabRevealWebglAtlasRecovery()
    vi.advanceTimersByTime(500)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)

    manager.resetWebglTextureAtlases.mockClear()
    scheduleImagePasteWebglAtlasRecovery()
    vi.advanceTimersByTime(500)
    expect(manager.resetWebglTextureAtlases).toHaveBeenCalledTimes(3)
  })
})
