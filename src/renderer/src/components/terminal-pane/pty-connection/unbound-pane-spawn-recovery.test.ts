import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import {
  REMOTE_RUNTIME_SPAWN_SETTLEMENT_WATCHDOG_MS,
  SPAWN_SETTLEMENT_WATCHDOG_MS,
  pendingSpawnByPaneKey,
  pendingSpawnGenerationByPaneKey
} from './pty-connect-limits'
import {
  armSpawnSettlementWatchdog,
  observeSpawnSettlement,
  settleSpawnThatLeftPaneUnbound
} from './unbound-pane-spawn-recovery'

vi.mock('../terminal-pane-recovery', () => ({
  requestTerminalPaneRecovery: vi.fn(),
  captureTerminalPaneRecoveryGeneration: vi.fn(() => 7)
}))

function buildSession(overrides: Record<string, unknown> = {}): never {
  return {
    deps: { tabId: 'tab-1', worktreeId: 'wt-1', restoredLeafId: 'leaf-1' },
    pane: { id: 4, leafId: 'pane-leaf' },
    terminalRecoveryGeneration: 2,
    terminalRecoveryInstance: { id: 3 },
    directSshRetryAttempt: undefined,
    settleDirectSshPaneRetryAttempt: vi.fn(),
    disposed: false,
    pendingSpawnKey: 'pane-key',
    transport: { getPtyId: () => null },
    ...overrides
  } as never
}

function observePinnedSpawn(...args: Parameters<typeof observeSpawnSettlement>): void {
  pendingSpawnByPaneKey.set(args[0].pendingSpawnKey, args[1])
  void args[1].finally(() => {
    if (pendingSpawnByPaneKey.get(args[0].pendingSpawnKey) === args[1]) {
      pendingSpawnByPaneKey.delete(args[0].pendingSpawnKey)
    }
  })
  observeSpawnSettlement(...args)
}

describe('settleSpawnThatLeftPaneUnbound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('remounts the tab so the pane rebinds over its live PTY', () => {
    settleSpawnThatLeftPaneUnbound(buildSession())

    expect(requestTerminalPaneRecovery).toHaveBeenCalledExactlyOnceWith({
      tabId: 'tab-1',
      ptyId: null,
      reason: 'spawn-left-pane-unbound',
      terminalRecoveryGeneration: 2,
      terminalRecoveryInstanceId: 3
    })
  })

  it('leaves recovery to the direct SSH retry ledger when it holds a lease', () => {
    const attempt = { attemptId: 'attempt-1' }
    const settleDirectSshPaneRetryAttempt = vi.fn()

    settleSpawnThatLeftPaneUnbound(
      buildSession({ directSshRetryAttempt: attempt, settleDirectSshPaneRetryAttempt })
    )

    expect(settleDirectSshPaneRetryAttempt).toHaveBeenCalledExactlyOnceWith(attempt, 'failed')
    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })

  it('settles the spawn as failed before remounting', () => {
    const settleDirectSshPaneRetryAttempt = vi.fn()

    settleSpawnThatLeftPaneUnbound(
      buildSession({ deps: { tabId: 'tab-settle' }, settleDirectSshPaneRetryAttempt })
    )

    expect(settleDirectSshPaneRetryAttempt).toHaveBeenCalledExactlyOnceWith(undefined, 'failed')
    expect(requestTerminalPaneRecovery).toHaveBeenCalledOnce()
  })

  // Distinct ids per case: warnTerminalLifecycleAnomaly dedups on a module-global key.
  it('prefers the restored leaf id when reporting the anomaly', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    settleSpawnThatLeftPaneUnbound(
      buildSession({ deps: { tabId: 'tab-warn', worktreeId: 'wt-1', restoredLeafId: 'leaf-1' } })
    )

    expect(warn).toHaveBeenCalledWith(
      '[terminal-lifecycle] fresh spawn left the pane unbound',
      expect.objectContaining({ leafId: 'leaf-1', paneId: 4, worktreeId: 'wt-1' })
    )
    warn.mockRestore()
  })

  it('falls back to the pane leaf id when no restored leaf exists', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    settleSpawnThatLeftPaneUnbound(
      buildSession({ deps: { tabId: 'tab-2', worktreeId: 'wt-2', restoredLeafId: null } })
    )

    expect(warn).toHaveBeenCalledWith(
      '[terminal-lifecycle] fresh spawn left the pane unbound',
      expect.objectContaining({ leafId: 'pane-leaf' })
    )
    warn.mockRestore()
  })
})

describe('armSpawnSettlementWatchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    pendingSpawnByPaneKey.clear()
    pendingSpawnGenerationByPaneKey.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function armNeverSettling(overrides: Record<string, unknown> = {}): {
    session: never
    promise: Promise<string | null>
  } {
    const promise = new Promise<string | null>(() => {})
    const session = buildSession({ pendingSpawnKey: 'pane-key', ...overrides })
    pendingSpawnByPaneKey.set(String(overrides.pendingSpawnKey ?? 'pane-key'), promise)
    armSpawnSettlementWatchdog(session, promise)
    return { session, promise }
  }

  it('remounts a pane whose spawn never settles', () => {
    armNeverSettling()

    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
    vi.advanceTimersByTime(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(requestTerminalPaneRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ reason: 'spawn-never-settled', ptyId: null })
    )
  })

  it('unpins the pane key a hung spawn would strand forever', () => {
    const { promise } = armNeverSettling()
    pendingSpawnByPaneKey.set('pane-key', promise)
    pendingSpawnGenerationByPaneKey.set('pane-key', 3)

    vi.advanceTimersByTime(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(pendingSpawnByPaneKey.has('pane-key')).toBe(false)
    expect(pendingSpawnGenerationByPaneKey.has('pane-key')).toBe(false)
  })

  it('leaves a pane key that a newer spawn already claimed', () => {
    armNeverSettling()
    const newerSpawn = Promise.resolve('pty-2')
    pendingSpawnByPaneKey.set('pane-key', newerSpawn)

    vi.advanceTimersByTime(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(pendingSpawnByPaneKey.get('pane-key')).toBe(newerSpawn)
    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })

  it('does not remount when a transport bound while it waited', () => {
    armNeverSettling({ transport: { getPtyId: () => 'pty-1' } })

    vi.advanceTimersByTime(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })

  it('leaves recovery to the direct SSH retry ledger when it holds a lease', () => {
    armNeverSettling({ directSshRetryAttempt: { attemptId: 'a1' } })

    vi.advanceTimersByTime(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })

  it('recovers by tab with no instance id when the arming pane is gone', () => {
    const { session } = armNeverSettling({ deps: { tabId: 'tab-gone' } })
    ;(session as unknown as { disposed: boolean }).disposed = true

    vi.advanceTimersByTime(SPAWN_SETTLEMENT_WATCHDOG_MS)

    const request = vi.mocked(requestTerminalPaneRecovery).mock.calls[0]?.[0]
    expect(request?.tabId).toBe('tab-gone')
    expect(request?.terminalRecoveryInstanceId).toBeUndefined()
  })

  it('cancels once the spawn settles', async () => {
    const session = buildSession({ pendingSpawnKey: 'settled-key' })
    armSpawnSettlementWatchdog(session, Promise.resolve('pty-1'))
    await vi.advanceTimersByTimeAsync(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })
})

// Why through observeSpawnSettlement and not the watchdog directly: this is the
// only caller fresh-spawn-start uses, so it is what proves the arming is wired.
describe('observeSpawnSettlement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    pendingSpawnByPaneKey.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('arms the settlement watchdog for a spawn that never settles', () => {
    observePinnedSpawn(
      buildSession({ deps: { tabId: 'tab-observe' }, pendingSpawnKey: 'observe-key' }),
      new Promise<string | null>(() => {})
    )

    vi.advanceTimersByTime(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(requestTerminalPaneRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tabId: 'tab-observe', reason: 'spawn-never-settled' })
    )
  })

  it('recovers a spawn that settles without a PTY id under the settled reason', async () => {
    observePinnedSpawn(
      buildSession({ deps: { tabId: 'tab-settled' }, pendingSpawnKey: 'settled-key' }),
      Promise.resolve(null)
    )

    await vi.advanceTimersByTimeAsync(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(requestTerminalPaneRecovery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tabId: 'tab-settled', reason: 'spawn-left-pane-unbound' })
    )
  })
})

describe('cold-restore resume spawns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    pendingSpawnByPaneKey.clear()
    pendingSpawnGenerationByPaneKey.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // Freeze-over-corruption: remounting a hung resume would start a second
  // --resume on the same transcript, and the late spawn is never retired.
  it('never remounts a resume spawn that hangs', () => {
    const promise = new Promise<string | null>(() => {})
    observePinnedSpawn(
      buildSession({ deps: { tabId: 'tab-resume' }, pendingSpawnKey: 'resume-key' }),
      promise,
      { resumesProviderSession: true }
    )
    pendingSpawnByPaneKey.set('resume-key', promise)

    vi.advanceTimersByTime(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
    // The stranded pin is still collected — that leak is safe to fix either way.
    expect(pendingSpawnByPaneKey.has('resume-key')).toBe(false)
  })

  // The adopting remount arms with no options of its own. If the exclusion rode
  // the arming call instead of the spawn, this pane would re-issue --resume.
  it('never remounts a resume spawn adopted by a remount whose arming pane was disposed', () => {
    const promise = new Promise<string | null>(() => {})
    observePinnedSpawn(buildSession({ deps: { tabId: 'tab-disposed' }, disposed: true }), promise, {
      resumesProviderSession: true
    })

    armSpawnSettlementWatchdog(buildSession({ deps: { tabId: 'tab-adopter' } }), promise)
    vi.advanceTimersByTime(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })

  it('still remounts a non-resume spawn that hangs', () => {
    observePinnedSpawn(
      buildSession({ deps: { tabId: 'tab-plain' }, pendingSpawnKey: 'plain-key' }),
      new Promise<string | null>(() => {}),
      { resumesProviderSession: false }
    )

    vi.advanceTimersByTime(SPAWN_SETTLEMENT_WATCHDOG_MS)

    expect(requestTerminalPaneRecovery).toHaveBeenCalledOnce()
  })
})

describe('remote-runtime spawns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    pendingSpawnByPaneKey.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // The create's own retry ladder can still be running at the local deadline.
  it('does not remount a remote-runtime pane at the local deadline', () => {
    observePinnedSpawn(
      buildSession({ deps: { tabId: 'tab-remote' }, runtimeEnvironmentId: 'env-1' }),
      new Promise<string | null>(() => {})
    )

    vi.advanceTimersByTime(SPAWN_SETTLEMENT_WATCHDOG_MS)
    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()

    vi.advanceTimersByTime(
      REMOTE_RUNTIME_SPAWN_SETTLEMENT_WATCHDOG_MS - SPAWN_SETTLEMENT_WATCHDOG_MS
    )
    expect(requestTerminalPaneRecovery).toHaveBeenCalledOnce()
  })
})
