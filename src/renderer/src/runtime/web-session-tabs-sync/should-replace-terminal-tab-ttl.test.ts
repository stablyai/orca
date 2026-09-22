import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { shouldReplaceTerminalTab } from './terminal-surfaces'

function makeTab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: 'local-tab-uuid-1',
    ptyId: null,
    worktreeId: 'env-1::worktree-1',
    title: 'Terminal 1',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: Date.now(),
    ...overrides
  }
}

describe('shouldReplaceTerminalTab TTL bound (#21340)', () => {
  const envId = 'env-1'
  const emptyPtyIds = new Set<string>()
  const emptyMirroredIds = new Set<string>()
  const emptyProvisional = new Set<string>()

  it('retains a freshly created tab with ptyId: null within the 30s grace period', () => {
    const now = 100_000
    const tab = makeTab({
      id: 'local-tab-uuid-1',
      ptyId: null,
      createdAt: now - 15_000 // 15s old (< 30s TTL)
    })

    const replace = shouldReplaceTerminalTab(
      tab,
      envId,
      emptyPtyIds,
      emptyMirroredIds,
      emptyProvisional,
      now
    )

    expect(replace).toBe(false)
  })

  it('evicts a tab with ptyId: null exceeding the 30s grace period', () => {
    const now = 100_000
    const tab = makeTab({
      id: 'local-tab-uuid-1',
      ptyId: null,
      createdAt: now - 31_000 // 31s old (> 30s TTL)
    })

    const replace = shouldReplaceTerminalTab(
      tab,
      envId,
      emptyPtyIds,
      emptyMirroredIds,
      emptyProvisional,
      now
    )

    expect(replace).toBe(true)
  })

  it('retains a tab when createdAt is undefined (e.g. legacy tab) and ptyId is null', () => {
    const now = 100_000
    const tab = makeTab({
      id: 'local-tab-uuid-1',
      ptyId: null,
      createdAt: undefined as unknown as number
    })

    const replace = shouldReplaceTerminalTab(
      tab,
      envId,
      emptyPtyIds,
      emptyMirroredIds,
      emptyProvisional,
      now
    )

    expect(replace).toBe(false)
  })

  it('replaces tab when ptyId matches nextRemotePtyIds regardless of createdAt', () => {
    const now = 100_000
    const tab = makeTab({
      id: 'local-tab-uuid-1',
      ptyId: `remote:${envId}@@pty-123`,
      createdAt: now - 5_000
    })

    const replace = shouldReplaceTerminalTab(
      tab,
      envId,
      new Set([`remote:${envId}@@pty-123`]),
      emptyMirroredIds,
      emptyProvisional,
      now
    )

    expect(replace).toBe(true)
  })
})
