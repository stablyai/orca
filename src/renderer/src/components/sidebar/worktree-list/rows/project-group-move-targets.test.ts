import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { MAX_PROJECT_GROUP_DEPTH } from '../../../../../../shared/project-group-reparent'
import { canCreateProjectSubgroup, getProjectGroupMoveTargets } from './project-group-move-targets'

function group(
  id: string,
  parentGroupId: string | null,
  overrides: Partial<ProjectGroup> = {}
): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    executionHostId: 'local',
    ...overrides
  }
}

const perc = group('perc', null, { tabOrder: 0 })
const backend = group('backend', 'perc', { tabOrder: 1 })
const api = group('api', 'backend', { tabOrder: 0 })
const tools = group('tools', null, { tabOrder: 1 })
const remote = group('remote', null, { executionHostId: 'ssh:builder' })
const all = [perc, backend, api, tools, remote]

describe('getProjectGroupMoveTargets', () => {
  it('lists same-host groups in sidebar order, skipping self and descendants', () => {
    expect(
      getProjectGroupMoveTargets(all, 'backend').map(({ group, depth, isCurrentParent }) => [
        group.id,
        depth,
        isCurrentParent
      ])
    ).toEqual([
      ['perc', 0, true],
      ['tools', 0, false]
    ])
  })

  it('excludes groups owned by another host', () => {
    expect(getProjectGroupMoveTargets(all, 'remote')).toEqual([])
    expect(getProjectGroupMoveTargets(all, 'tools').map(({ group }) => group.id)).toEqual([
      'perc',
      'backend',
      'api'
    ])
  })

  it('returns nothing for an unknown group', () => {
    expect(getProjectGroupMoveTargets(all, 'missing')).toEqual([])
  })

  it('drops destinations that would push the subtree past the depth cap', () => {
    const chain: ProjectGroup[] = []
    for (let depth = 0; depth <= MAX_PROJECT_GROUP_DEPTH; depth += 1) {
      chain.push(group(`g${depth}`, depth === 0 ? null : `g${depth - 1}`))
    }
    const groups = [...chain, perc, backend]

    const targets = getProjectGroupMoveTargets(groups, 'perc').map(({ group }) => group.id)
    expect(targets).toContain(`g${MAX_PROJECT_GROUP_DEPTH - 2}`)
    expect(targets).not.toContain(`g${MAX_PROJECT_GROUP_DEPTH - 1}`)
    expect(targets).not.toContain(`g${MAX_PROJECT_GROUP_DEPTH}`)
  })
})

describe('canCreateProjectSubgroup', () => {
  it('allows nesting until the depth cap and rejects unknown groups', () => {
    const chain: ProjectGroup[] = []
    for (let depth = 0; depth <= MAX_PROJECT_GROUP_DEPTH; depth += 1) {
      chain.push(group(`g${depth}`, depth === 0 ? null : `g${depth - 1}`))
    }
    expect(canCreateProjectSubgroup(chain, `g${MAX_PROJECT_GROUP_DEPTH - 1}`)).toBe(true)
    expect(canCreateProjectSubgroup(chain, `g${MAX_PROJECT_GROUP_DEPTH}`)).toBe(false)
    expect(canCreateProjectSubgroup(chain, 'missing')).toBe(false)
  })
})
