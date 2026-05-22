import { describe, expect, it } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import { getTerminalTabSlices } from './terminal-tab-slices'

const tab = (id: string, worktreeId = 'wt-active'): TerminalTab => ({
  id,
  title: id,
  ptyId: null,
  worktreeId,
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 0,
  generation: 0
})

describe('getTerminalTabSlices', () => {
  it('preserves slices when an unmounted worktree tab array changes', () => {
    const activeTabs = [tab('active')]
    const mountedIds = new Set(['wt-active'])
    const first = getTerminalTabSlices(
      { 'wt-active': activeTabs, 'wt-hidden': [tab('hidden-a', 'wt-hidden')] },
      mountedIds,
      'wt-active'
    )
    const second = getTerminalTabSlices(
      { 'wt-active': activeTabs, 'wt-hidden': [tab('hidden-b', 'wt-hidden')] },
      mountedIds,
      'wt-active'
    )

    expect(second).toBe(first)
    expect(second.activeTabs).toBe(activeTabs)
  })

  it('updates slices when a mounted worktree tab array changes', () => {
    const mountedIds = new Set(['wt-active', 'wt-mounted'])
    const first = getTerminalTabSlices(
      { 'wt-active': [tab('active')], 'wt-mounted': [tab('mounted-a', 'wt-mounted')] },
      mountedIds,
      'wt-active'
    )
    const mountedTabs = [tab('mounted-b', 'wt-mounted')]
    const second = getTerminalTabSlices(
      { 'wt-active': first.activeTabs, 'wt-mounted': mountedTabs },
      mountedIds,
      'wt-active'
    )

    expect(second).not.toBe(first)
    expect(second.mountedTabsByWorktree['wt-mounted']).toBe(mountedTabs)
  })

  it('keeps active tabs available even before the active worktree is mounted', () => {
    const activeTabs = [tab('active')]
    const slices = getTerminalTabSlices({ 'wt-active': activeTabs }, new Set(), 'wt-active')

    expect(slices.activeTabs).toBe(activeTabs)
    expect(slices.mountedTabsByWorktree).toEqual({})
  })
})
