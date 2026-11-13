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
})
