import { beforeEach, describe, expect, it, vi } from 'vitest'
import { requestTerminalPaneRecovery } from '../terminal-pane-recovery'
import { settleSpawnThatLeftPaneUnbound } from './unbound-pane-spawn-recovery'

vi.mock('../terminal-pane-recovery', () => ({
  requestTerminalPaneRecovery: vi.fn()
}))

function buildSession(overrides: Record<string, unknown> = {}): never {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bag names every session member settleSpawnThatLeftPaneUnbound reads.
  return {
    deps: { tabId: 'tab-1', worktreeId: 'wt-1', restoredLeafId: 'leaf-1' },
    pane: { id: 4, leafId: 'pane-leaf' },
    terminalRecoveryGeneration: 2,
    terminalRecoveryInstance: { id: 3 },
    settlePaneAttachAttempt: vi.fn(),
    transport: {},
    ...overrides
  } as never
}

describe('settleSpawnThatLeftPaneUnbound', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requests a tab remount for an unbound spawn', () => {
    settleSpawnThatLeftPaneUnbound(buildSession())

    expect(requestTerminalPaneRecovery).toHaveBeenCalledExactlyOnceWith({
      tabId: 'tab-1',
      ptyId: null,
      reason: 'spawn-left-pane-unbound',
      terminalRecoveryGeneration: 2,
      terminalRecoveryInstanceId: 3
    })
  })

  // #21195: a remount here would race the transport's own armed retry onto the same pane.
  it('leaves recovery to a remote transport that armed its own retry', () => {
    const settlePaneAttachAttempt = vi.fn()

    settleSpawnThatLeftPaneUnbound(
      buildSession({ transport: { ownsRecovery: () => true }, settlePaneAttachAttempt })
    )

    expect(settlePaneAttachAttempt).toHaveBeenCalledExactlyOnceWith('failed')
    expect(requestTerminalPaneRecovery).not.toHaveBeenCalled()
  })

  it('requests a remount when the transport reports no recovery of its own', () => {
    settleSpawnThatLeftPaneUnbound(buildSession({ transport: { ownsRecovery: () => false } }))

    expect(requestTerminalPaneRecovery).toHaveBeenCalledOnce()
  })

  it('settles the spawn as failed before requesting a remount', () => {
    const settlePaneAttachAttempt = vi.fn()

    settleSpawnThatLeftPaneUnbound(
      buildSession({ deps: { tabId: 'tab-settle' }, settlePaneAttachAttempt })
    )

    expect(settlePaneAttachAttempt).toHaveBeenCalledExactlyOnceWith('failed')
    expect(requestTerminalPaneRecovery).toHaveBeenCalledOnce()
    expect(settlePaneAttachAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(requestTerminalPaneRecovery).mock.invocationCallOrder[0]
    )
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
