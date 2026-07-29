import { describe, expect, it } from 'vitest'
import {
  createProjectGroupReparentIndex,
  createProjectGroupReparentValidator,
  getProjectGroupReparentViolation
} from './project-group-reparent'

describe('project group reparent validation', () => {
  it('validates reparent targets', () => {
    const groups = [
      { id: 'root', parentGroupId: null },
      { id: 'child', parentGroupId: 'root' },
      { id: 'grandchild', parentGroupId: 'child' },
      { id: 'other', parentGroupId: null }
    ]

    expect(getProjectGroupReparentViolation(groups, 'other', null)).toBeNull()
    expect(getProjectGroupReparentViolation(groups, 'other', 'root')).toBeNull()
    expect(getProjectGroupReparentViolation(groups, 'missing', 'root')).toBe('missing-group')
    expect(getProjectGroupReparentViolation(groups, 'other', 'missing')).toBe('missing-parent')
    expect(getProjectGroupReparentViolation(groups, 'other', 'other')).toBe('self')
    expect(getProjectGroupReparentViolation(groups, 'root', 'grandchild')).toBe('cycle')
    // other (leaf) under grandchild would land at depth 4 with a 3-level cap.
    expect(getProjectGroupReparentViolation(groups, 'other', 'grandchild')).toBe('depth')
  })

  it('rejects reparenting a subtree that would poke through the depth cap', () => {
    const groups = [
      { id: 'root', parentGroupId: null },
      { id: 'tall', parentGroupId: null },
      { id: 'tall-child', parentGroupId: 'tall' }
    ]

    // tall itself fits under root, but its child would land at depth 4.
    expect(getProjectGroupReparentViolation(groups, 'tall', 'root')).toBeNull()

    const deeper = [...groups, { id: 'tall-grandchild', parentGroupId: 'tall-child' }]
    expect(getProjectGroupReparentViolation(deeper, 'tall', 'root')).toBe('depth')
  })

  it('precomputed reparent validator matches one-shot validation across repeated calls', () => {
    const groups = [
      { id: 'root', parentGroupId: null },
      { id: 'child', parentGroupId: 'root' },
      { id: 'grandchild', parentGroupId: 'child' },
      { id: 'other', parentGroupId: null }
    ]
    const validate = createProjectGroupReparentValidator(groups, 'other')
    const targets = [null, 'root', 'child', 'grandchild', 'other', 'missing']
    for (const target of targets) {
      expect(validate(target)).toBe(getProjectGroupReparentViolation(groups, 'other', target))
      // Second pass hits the memoized depth index.
      expect(validate(target)).toBe(getProjectGroupReparentViolation(groups, 'other', target))
    }
    expect(createProjectGroupReparentValidator(groups, 'missing')('root')).toBe('missing-group')
    expect(createProjectGroupReparentValidator(groups, 'root')('grandchild')).toBe('cycle')
  })

  it('builds the reusable index from a single iterable pass', () => {
    const groups = [
      { id: 'root', parentGroupId: null },
      { id: 'child', parentGroupId: 'root' },
      { id: 'grandchild', parentGroupId: 'child' },
      { id: 'other', parentGroupId: null }
    ]
    let iterationCount = 0
    const groupIterable = {
      *[Symbol.iterator]() {
        iterationCount += 1
        yield* groups
      }
    }

    const index = createProjectGroupReparentIndex(groupIterable, 'child')

    expect(iterationCount).toBe(1)
    expect(index.subtreeIds).toEqual(new Set(['child', 'grandchild']))
    expect(index.validate('other')).toBeNull()
    expect(index.validate('grandchild')).toBe('cycle')
  })

  it('keeps depth validation query-order independent for cyclic input', () => {
    const groups = [
      { id: 'a', parentGroupId: 'b' },
      { id: 'b', parentGroupId: 'c' },
      { id: 'c', parentGroupId: 'a' },
      { id: 'dragged', parentGroupId: null }
    ]
    const forward = createProjectGroupReparentValidator(groups, 'dragged')
    const reverse = createProjectGroupReparentValidator(groups, 'dragged')

    expect(['a', 'b', 'c'].map((target) => forward(target))).toEqual(['depth', 'depth', 'depth'])
    expect(['c', 'b', 'a'].map((target) => reverse(target))).toEqual(['depth', 'depth', 'depth'])
  })

  it('answers repeated reparent queries against a huge catalog without rescanning', () => {
    const groups = [
      { id: 'root', parentGroupId: null },
      ...Array.from({ length: 130_000 }, (_, index) => ({
        id: `child-${index}`,
        parentGroupId: 'root'
      }))
    ]
    // One validator per drag; per-frame drop targeting then queries it for
    // whichever header the pointer crosses.
    const validate = createProjectGroupReparentValidator(groups, 'child-0')
    let violations = 0
    for (let index = 1; index <= 10_000; index += 1) {
      if (validate(`child-${index}`) !== null) {
        violations += 1
      }
    }
    expect(violations).toBe(0)
    expect(validate('root')).toBeNull()
    expect(validate('child-0')).toBe('self')
  })
})
