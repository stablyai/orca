// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

const record = vi.hoisted(() => vi.fn())

vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: true
}))
vi.mock('@/lib/agent-session/history/session-names/terminal-session-name-recording', () => ({
  recordTerminalTabRename: record
}))

import { useAppStore } from '../index'

describe('tab rename when main owns the layout', () => {
  it('records the session name before the rename is routed to main', () => {
    const tab = {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'claude',
      customTitle: 'Old',
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    useAppStore.setState({ tabsByWorktree: { 'wt-1': [tab] } })
    let seenTitle: string | null | undefined
    record.mockImplementation((state: ReturnType<typeof useAppStore.getState>) => {
      seenTitle = state.tabsByWorktree['wt-1']?.[0]?.customTitle
    })
    try {
      useAppStore.getState().setTabCustomTitle('tab-1', 'Fix auth bug')
    } catch {
      // Routing to main needs the desktop bridge, which tests do not have; recording came first.
    }
    expect(record).toHaveBeenCalledWith(expect.anything(), 'tab-1', 'Fix auth bug', {
      interactive: true
    })
    expect(seenTitle).toBe('Old')
  })
})
