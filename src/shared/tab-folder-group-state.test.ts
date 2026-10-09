import { describe, expect, it } from 'vitest'
import type { TabFolderGroup } from './tab-folder-types'
import { syncFolderTabOrdersFromGroupOrder } from './tab-folder-group-state'

function makeFolder(
  id: string,
  splitGroupId: string,
  tabOrder: string[]
): TabFolderGroup {
  return {
    id,
    worktreeId: 'wt-1',
    splitGroupId,
    name: id,
    color: '#3b82f6',
    collapsed: false,
    tabOrder,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('syncFolderTabOrdersFromGroupOrder', () => {
  it('reorders only folders in the given split group', () => {
    const left = makeFolder('left-folder', 'split-left', ['a', 'b'])
    const right = makeFolder('right-folder', 'split-right', ['c', 'd'])

    const next = syncFolderTabOrdersFromGroupOrder([left, right], ['b', 'a'], 'split-left')

    expect(next.find((folder) => folder.id === left.id)?.tabOrder).toEqual(['b', 'a'])
    expect(next.find((folder) => folder.id === right.id)?.tabOrder).toEqual(['c', 'd'])
  })
})
