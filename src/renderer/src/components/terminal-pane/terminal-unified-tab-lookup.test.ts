import { describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/types'
import { getCachedTerminalGroupIdForWorktree } from './terminal-unified-tab-lookup'

function makeTerminalTab(entityId: string, groupId: string): Tab {
  return {
    id: entityId,
    entityId,
    groupId,
    worktreeId: 'wt-1',
    contentType: 'terminal',
    label: entityId,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeEditorTab(id: string): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group-editor',
    worktreeId: 'wt-1',
    contentType: 'editor',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function iterableTabs(tabs: Tab[]): {
  value: Tab[]
  iterator: ReturnType<typeof vi.fn>
} {
  const iterator = vi.fn(function* () {
    yield* tabs
  })
  return {
    value: { [Symbol.iterator]: iterator } as unknown as Tab[],
    iterator
  }
}

describe('getCachedTerminalGroupIdForWorktree', () => {
  it('reuses the terminal group lookup while the unified tab array is unchanged', () => {
    const tabs = [
      makeEditorTab('editor-1'),
      ...Array.from({ length: 200 }, (_, index) =>
        makeTerminalTab(`terminal-${index}`, `group-${index % 4}`)
      )
    ]
    const { value, iterator } = iterableTabs(tabs)
    const unifiedTabsByWorktree = { 'wt-1': value }

    expect(getCachedTerminalGroupIdForWorktree(unifiedTabsByWorktree, 'wt-1', 'terminal-199')).toBe(
      'group-3'
    )
    expect(getCachedTerminalGroupIdForWorktree(unifiedTabsByWorktree, 'wt-1', 'terminal-0')).toBe(
      'group-0'
    )
    expect(
      getCachedTerminalGroupIdForWorktree(unifiedTabsByWorktree, 'wt-1', 'editor-1')
    ).toBeNull()

    expect(iterator).toHaveBeenCalledTimes(1)
  })

  it('rebuilds the lookup when the unified tab array reference changes', () => {
    const first = iterableTabs([makeTerminalTab('terminal-1', 'group-a')])
    const second = iterableTabs([makeTerminalTab('terminal-1', 'group-b')])

    expect(getCachedTerminalGroupIdForWorktree({ 'wt-1': first.value }, 'wt-1', 'terminal-1')).toBe(
      'group-a'
    )
    expect(
      getCachedTerminalGroupIdForWorktree({ 'wt-1': second.value }, 'wt-1', 'terminal-1')
    ).toBe('group-b')

    expect(first.iterator).toHaveBeenCalledTimes(1)
    expect(second.iterator).toHaveBeenCalledTimes(1)
  })
})
