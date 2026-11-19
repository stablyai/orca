// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const flags = vi.hoisted(() => ({ layoutOwnerIsMain: false }))
const record = vi.hoisted(() => vi.fn())

vi.mock('../../../../shared/workspace-layout/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return flags.layoutOwnerIsMain
  }
}))
vi.mock('@/lib/agent-session/history/session-names/terminal-session-name-recording', () => ({
  recordTerminalTabRename: record
}))

describe.each([false, true])('tab rename with main owning layout: %s', (layoutOwnerIsMain) => {
  beforeEach(() => {
    vi.resetModules()
    record.mockClear()
    flags.layoutOwnerIsMain = layoutOwnerIsMain
  })

  it("records the tab's session name before the rename is applied", async () => {
    const { useAppStore } = await import('../index')
    record.mockImplementation((state: { tabsByWorktree: Record<string, unknown> }) => {
      // The recorder sees the state from before the rename.
      expect(state.tabsByWorktree).toEqual({})
    })
    useAppStore.getState().setTabCustomTitle('tab-1', 'Fix auth bug')
    expect(record).toHaveBeenCalledWith(expect.anything(), 'tab-1', 'Fix auth bug', {
      interactive: true
    })
  })

  it('still renames when recording fails', async () => {
    const { useAppStore } = await import('../index')
    const tab = {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'claude',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    useAppStore.setState({ tabsByWorktree: { 'wt-1': [tab] } })
    record.mockImplementation(() => {
      throw new Error('boom')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useAppStore.getState().setTabCustomTitle('tab-1', 'Fix auth bug', { recordInteraction: false })
    expect(record).toHaveBeenCalledWith(expect.anything(), 'tab-1', 'Fix auth bug', {
      interactive: false
    })
    expect(warn).toHaveBeenCalled()
    if (!layoutOwnerIsMain) {
      // Without main owning layout the rename lands in this store at once.
      expect(useAppStore.getState().tabsByWorktree['wt-1'][0].customTitle).toBe('Fix auth bug')
    }
    warn.mockRestore()
  })
})
