// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchTerminalCommandFinishedEvent } from '@/hooks/terminal-command-finished-event'
import { closeQuickCommandTabOnSuccess } from './quick-command-close-tab-on-success'

const leaf = (leafId: string) => ({ type: 'leaf', leafId })

const mockState: {
  closeTab: ReturnType<typeof vi.fn>
  tabsByWorktree: Record<string, { id: string }[]>
  terminalLayoutsByTabId: Record<string, { root: unknown }>
} = {
  closeTab: vi.fn(),
  tabsByWorktree: {},
  terminalLayoutsByTabId: {}
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mockState }
}))

describe('closeQuickCommandTabOnSuccess', () => {
  beforeEach(() => {
    mockState.closeTab.mockReset()
    mockState.tabsByWorktree = { wt: [{ id: 'tab-1' }, { id: 'tab-2' }] }
    mockState.terminalLayoutsByTabId = {}
  })

  it('closes the tab when its first command exits 0, and ignores later commands', () => {
    closeQuickCommandTabOnSuccess('tab-1', 'wt')
    dispatchTerminalCommandFinishedEvent('wt', 0, 'tab-2')
    expect(mockState.closeTab).not.toHaveBeenCalled()

    dispatchTerminalCommandFinishedEvent('wt', 0, 'tab-1')
    expect(mockState.closeTab).toHaveBeenCalledWith('tab-1', { recordInteraction: false })

    mockState.closeTab.mockReset()
    dispatchTerminalCommandFinishedEvent('wt', 0, 'tab-1')
    expect(mockState.closeTab).not.toHaveBeenCalled()
  })

  it('keeps the tab open on failure, unknown exit, or after a split', () => {
    closeQuickCommandTabOnSuccess('tab-1', 'wt')
    dispatchTerminalCommandFinishedEvent('wt', 1, 'tab-1')

    closeQuickCommandTabOnSuccess('tab-1', 'wt')
    dispatchTerminalCommandFinishedEvent('wt', null, 'tab-1')

    mockState.terminalLayoutsByTabId['tab-1'] = {
      root: { type: 'split', first: leaf('a'), second: leaf('b') }
    }
    closeQuickCommandTabOnSuccess('tab-1', 'wt')
    dispatchTerminalCommandFinishedEvent('wt', 0, 'tab-1')

    expect(mockState.closeTab).not.toHaveBeenCalled()
  })
})
