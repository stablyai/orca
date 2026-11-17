import { describe, expect, it } from 'vitest'
import { normalizeProjectGroups } from './project-groups'

function normalizedParents(value: unknown[]): Record<string, string | null> {
  return Object.fromEntries(
    normalizeProjectGroups(value).map((group) => [group.id, group.parentGroupId])
  )
}

describe('normalizeProjectGroups parent cycles', () => {
  it('breaks a persisted cycle at the group that sorts first and keeps every group', () => {
    const twoCycle = [
      { id: 'a', name: 'A', tabOrder: 0, parentGroupId: 'b' },
      { id: 'b', name: 'B', tabOrder: 1, parentGroupId: 'a' }
    ]

    expect(normalizedParents(twoCycle)).toEqual({ a: null, b: 'a' })
    expect(normalizedParents(twoCycle.toReversed())).toEqual({ a: null, b: 'a' })
    expect(
      normalizedParents([
        { id: 'a', name: 'A', tabOrder: 2, parentGroupId: 'b' },
        { id: 'b', name: 'B', tabOrder: 0, parentGroupId: 'c' },
        { id: 'c', name: 'C', tabOrder: 1, parentGroupId: 'a' }
      ])
    ).toEqual({ a: 'b', b: null, c: 'a' })
  })

  it('cuts a cycle reached through a tail without detaching the tail', () => {
    expect(
      normalizedParents([
        { id: 'tail', name: 'Tail', tabOrder: 0, parentGroupId: 'a' },
        { id: 'a', name: 'A', tabOrder: 1, parentGroupId: 'b' },
        { id: 'b', name: 'B', tabOrder: 2, parentGroupId: 'a' }
      ])
    ).toEqual({ tail: 'a', a: null, b: 'a' })
  })
})
