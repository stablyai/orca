import { describe, expect, it } from 'vitest'
import {
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
