import { describe, expect, it } from 'vitest'
import { createProjectGroup } from './project-groups'
import {
  filterProjectGroupsForFocus,
  getFocusedProjectGroupSubtreeIds,
  isMembershipInFocusedProjectGroup,
  resolveFocusedProjectGroupId
} from './project-group-focus'

describe('project-group-focus', () => {
  const root = createProjectGroup({ name: 'Acme', createdFrom: 'manual', tabOrder: 0, now: 1 })
  const child = createProjectGroup({
    name: 'Platform',
    createdFrom: 'manual',
    tabOrder: 0,
    parentGroupId: root.id,
    now: 2
  })
  const other = createProjectGroup({ name: 'Other Co', createdFrom: 'manual', tabOrder: 1, now: 3 })
  const groups = [root, child, other]

  it('resolves a live focus id and clears a stale one', () => {
    expect(resolveFocusedProjectGroupId(groups, root.id)).toBe(root.id)
    expect(resolveFocusedProjectGroupId(groups, 'missing')).toBeNull()
    expect(resolveFocusedProjectGroupId(groups, null)).toBeNull()
  })

  it('collects the focused client subtree', () => {
    const subtree = getFocusedProjectGroupSubtreeIds(groups, root.id)
    expect(subtree).toEqual(new Set([root.id, child.id]))
    expect(getFocusedProjectGroupSubtreeIds(groups, null)).toBeNull()
  })

  it('filters membership and group catalogs to the focused subtree', () => {
    const subtree = getFocusedProjectGroupSubtreeIds(groups, root.id)
    expect(isMembershipInFocusedProjectGroup(root.id, subtree)).toBe(true)
    expect(isMembershipInFocusedProjectGroup(other.id, subtree)).toBe(false)
    expect(isMembershipInFocusedProjectGroup(null, subtree)).toBe(false)
    expect(isMembershipInFocusedProjectGroup(null, null)).toBe(true)
    expect(filterProjectGroupsForFocus(groups, subtree).map((group) => group.id)).toEqual([
      root.id,
      child.id
    ])
  })
})
