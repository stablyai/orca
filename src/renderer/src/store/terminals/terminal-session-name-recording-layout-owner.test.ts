// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'

const record = vi.hoisted(() => vi.fn())
const sendLayoutApply = vi.hoisted(() => vi.fn(() => true))

vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  ORCA_LAYOUT_OWNER_IS_MAIN: true
}))
vi.mock('@/lib/agent-session/history/session-names/terminal-session-name-recording', () => ({
  recordTerminalTabRename: record
}))
vi.mock('@/runtime/workspace-layout/commands/layout-apply-send', () => ({ sendLayoutApply }))

import { useAppStore } from '../index'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'

describe('tab rename when main owns the layout', () => {
  it('records the session name, then routes the rename to main', () => {
    const terminalTab = {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'claude',
      customTitle: 'Old',
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    const barTab: Tab = {
      id: 'unified-1',
      entityId: 'tab-1',
      groupId: 'group-1',
      worktreeId: 'wt-1',
      contentType: 'terminal',
      label: 'claude',
      customLabel: 'Old',
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [terminalTab] },
      unifiedTabsByWorktree: { 'wt-1': [barTab] }
    })
    let seenTitle: string | null | undefined
    record.mockImplementation((state: ReturnType<typeof useAppStore.getState>) => {
      seenTitle = state.tabsByWorktree['wt-1']?.[0]?.customTitle
    })
    useAppStore.getState().setTabCustomTitle('tab-1', 'Fix auth bug')
    expect(record).toHaveBeenCalledWith(expect.anything(), 'tab-1', 'Fix auth bug', {
      interactive: true
    })
    expect(seenTitle).toBe('Old')
    expect(sendLayoutApply).toHaveBeenCalledWith(
      expect.anything(),
      'wt-1',
      expect.objectContaining({ type: 'renameTab', kind: 'custom', title: 'Fix auth bug' }),
      expect.anything()
    )
    expect(record.mock.invocationCallOrder[0]).toBeLessThan(
      sendLayoutApply.mock.invocationCallOrder[0]
    )

    sendLayoutApply.mockClear()
    record.mockImplementation(() => {
      throw new Error('recording failed')
    })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      useAppStore.getState().setTabCustomTitle('tab-1', 'Still renames')
      expect(sendLayoutApply).toHaveBeenCalledWith(
        expect.anything(),
        'wt-1',
        expect.objectContaining({ type: 'renameTab', kind: 'custom', title: 'Still renames' }),
        expect.anything()
      )
    } finally {
      warning.mockRestore()
    }
  })
})
