import { describe, expect, it } from 'vitest'
import { canManuallyParkTerminalWorktreeRenderers } from './manual-terminal-worktree-park-eligibility'

describe('canManuallyParkTerminalWorktreeRenderers', () => {
  const base = {
    worktreeId: 'repo::/worktree',
    terminalTabs: [{ id: 'tab-1', ptyId: 'repo::/worktree@@session-1' }],
    pendingStartupByTabId: {},
    parkingEnabled: true,
    hasLivePty: () => true
  }

  it('bypasses visibility timing for snapshot-backed local terminals', () => {
    expect(canManuallyParkTerminalWorktreeRenderers(base)).toBe(true)
  })

  // Why: first activation stamps pendingActivationSpawn on every tab and only a
  // fresh updateTabPtyId consumes it, so a reattached tab keeps it forever —
  // that residue must not permanently refuse a manual park.
  it('ignores a settled activation-spawn tag once the tab has a live PTY', () => {
    const terminalTabs = [
      { id: 'tab-1', ptyId: 'repo::/worktree@@session-1', pendingActivationSpawn: true as const }
    ]

    expect(canManuallyParkTerminalWorktreeRenderers({ ...base, terminalTabs })).toBe(true)
    expect(
      canManuallyParkTerminalWorktreeRenderers({
        ...base,
        terminalTabs,
        hasLivePty: () => false
      })
    ).toBe(false)
  })

  it('still refuses a multi-pane activation spawn that has not finished', () => {
    expect(
      canManuallyParkTerminalWorktreeRenderers({
        ...base,
        terminalTabs: [
          { id: 'tab-1', ptyId: 'repo::/worktree@@session-1', pendingActivationSpawn: 2 }
        ],
        hasLivePty: () => false
      })
    ).toBe(false)
  })

  it('preserves safety gates for empty, pending, remote, and disabled terminals', () => {
    expect(canManuallyParkTerminalWorktreeRenderers({ ...base, terminalTabs: [] })).toBe(false)
    expect(
      canManuallyParkTerminalWorktreeRenderers({
        ...base,
        pendingStartupByTabId: { 'tab-1': ['echo', 'pending'] }
      })
    ).toBe(false)
    expect(
      canManuallyParkTerminalWorktreeRenderers({
        ...base,
        terminalTabs: [{ id: 'tab-1', ptyId: 'ssh:ssh-1@@pty-1' }]
      })
    ).toBe(false)
    expect(canManuallyParkTerminalWorktreeRenderers({ ...base, parkingEnabled: false })).toBe(false)
  })
})
