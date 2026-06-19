import { describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/types'
import { getCachedTerminalTabForWorktree } from './terminal-tab-lookup'

function makeTab(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'wt-1',
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function iterableTabs(tabs: TerminalTab[]): {
  value: TerminalTab[]
  iterator: ReturnType<typeof vi.fn>
} {
  const iterator = vi.fn(function* () {
    yield* tabs
  })
  return {
    value: { [Symbol.iterator]: iterator } as unknown as TerminalTab[],
    iterator
  }
}

describe('getCachedTerminalTabForWorktree', () => {
  it('reuses the tab lookup while the worktree tab array is unchanged', () => {
    const tabs = Array.from({ length: 200 }, (_, index) => makeTab(`tab-${index}`))
    const { value, iterator } = iterableTabs(tabs)
    const tabsByWorktree = { 'wt-1': value }

    expect(getCachedTerminalTabForWorktree(tabsByWorktree, 'wt-1', 'tab-199')).toBe(tabs[199])
    expect(getCachedTerminalTabForWorktree(tabsByWorktree, 'wt-1', 'tab-0')).toBe(tabs[0])

    expect(iterator).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the lookup when the tab array reference changes', () => {
    const first = iterableTabs([makeTab('tab-1')])
    const second = iterableTabs([makeTab('tab-2')])

    expect(getCachedTerminalTabForWorktree({ 'wt-1': first.value }, 'wt-1', 'tab-1')?.id).toBe(
      'tab-1'
    )
    expect(getCachedTerminalTabForWorktree({ 'wt-1': second.value }, 'wt-1', 'tab-2')?.id).toBe(
      'tab-2'
    )

    expect(first.iterator).toHaveBeenCalledTimes(1)
    expect(second.iterator).toHaveBeenCalledTimes(1)
  })
})
