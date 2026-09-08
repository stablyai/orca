import { expect, it, vi } from 'vitest'
import { compactWorkspaceSpaceItems } from './workspace-space-compaction'
import type { WorkspaceSpaceItem } from './workspace-space-types'

it('sums omitted sizes without constructing a replacement object per omitted item', () => {
  const items: WorkspaceSpaceItem[] = Array.from({ length: 10000 }, (_, index) => ({
    name: String(index),
    path: String(index),
    kind: 'file',
    sizeBytes: index
  }))
  const original = Array.prototype.reduce
  let objectAccumulators = 0
  const spy = vi.spyOn(Array.prototype, 'reduce').mockImplementation(function (
    this: unknown[],
    callback,
    initial: unknown
  ) {
    if (initial && typeof initial === 'object' && 'name' in initial && initial.name === 'Other') {
      objectAccumulators += this.length
    }
    return Reflect.apply(original, this, [callback, initial])
  })
  let result: ReturnType<typeof compactWorkspaceSpaceItems>
  try {
    result = compactWorkspaceSpaceItems(items)
  } finally {
    spy.mockRestore()
  }
  expect(objectAccumulators).toBe(0)
  expect(result!.topLevelItems).toHaveLength(48)
  expect(result!.omittedTopLevelItemCount).toBe(9953)
  expect(result!.omittedTopLevelSizeBytes).toBe((9952 * 9953) / 2)
  expect(result!.topLevelItems[0]).toBe(items[9999])
  expect(items[0].sizeBytes).toBe(0)
})

it('preserves small-list size ties and empty results', () => {
  expect(compactWorkspaceSpaceItems([]).topLevelItems).toEqual([])
  const items: WorkspaceSpaceItem[] = ['b', 'a'].map((name) => ({
    name,
    path: name,
    kind: 'file',
    sizeBytes: 1
  }))
  expect(compactWorkspaceSpaceItems(items).topLevelItems.map((item) => item.name)).toEqual([
    'a',
    'b'
  ])
})
