import { describe, expect, it } from 'vitest'
import { selectCodexStaleSessionCount } from './codex-restart-status-summary'

const awaiting = { previousAccountLabel: 'old', nextAccountLabel: 'new' }

describe('selectCodexStaleSessionCount', () => {
  it('counts awaiting notices only while a stale session is bound to a tab', () => {
    expect(
      selectCodexStaleSessionCount({
        ptyIdsByTabId: { tab: ['pty-1', 'pty-2'] },
        codexRestartNoticeByPtyId: {
          'pty-1': awaiting,
          'pty-2': { ...awaiting, restartRequested: true },
          'pty-3': { ...awaiting, dismissed: true }
        }
      })
    ).toBe(1)
    expect(
      selectCodexStaleSessionCount({
        ptyIdsByTabId: {},
        codexRestartNoticeByPtyId: { orphan: awaiting }
      })
    ).toBe(0)
  })

  it('recomputes on a new map identity and reuses the result for the same identities', () => {
    const ptyIdsByTabId = { tab: ['pty-1'] }
    const codexRestartNoticeByPtyId: Record<string, typeof awaiting> = { 'pty-1': awaiting }
    const state = { ptyIdsByTabId, codexRestartNoticeByPtyId }
    expect(selectCodexStaleSessionCount(state)).toBe(1)
    // Same identities: the memo answers even though the map was mutated behind the store's back.
    delete codexRestartNoticeByPtyId['pty-1']
    expect(selectCodexStaleSessionCount(state)).toBe(1)
    expect(selectCodexStaleSessionCount({ ptyIdsByTabId, codexRestartNoticeByPtyId: {} })).toBe(0)
  })
})
