import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  getProjectGroupMoveTargetsForGroup,
  getProjectGroupMoveTargetsForProject,
  type ProjectGroupMoveTarget
} from './project-group-move-targets'

function group(id: string, overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id,
    name: id,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function chain(prefix: string, length: number, overrides: Partial<ProjectGroup> = {}) {
  return Array.from({ length }, (_, index) =>
    group(`${prefix}${index + 1}`, {
      ...overrides,
      parentGroupId: index === 0 ? null : `${prefix}${index}`
    })
  )
}

// Indented outline so assertions read like the rendered submenu.
function outline(targets: readonly ProjectGroupMoveTarget[]): string[] {
  return targets.map(
    ({ group: target, depth, disabled }) =>
      `${'  '.repeat(depth)}${target.name}${disabled ? ' (disabled)' : ''}`
  )
}

describe('getProjectGroupMoveTargetsForGroup', () => {
  it('lists the sidebar tree without the moving group and disables the current parent', () => {
    const groups = [
      group('personal', { name: 'Personal', tabOrder: 1 }),
      group('acme', { name: 'Acme', tabOrder: 0 }),
      group('acme-web', { name: 'Web', parentGroupId: 'acme', tabOrder: 1 }),
      group('acme-infra', { name: 'Infra', parentGroupId: 'acme', tabOrder: 0 }),
      group('personal-web', { name: 'Web', parentGroupId: 'personal', tabOrder: 0 }),
      group('blog', { name: 'Blog', parentGroupId: 'personal', tabOrder: 1 }),
      group('drafts', { name: 'Drafts', parentGroupId: 'blog' })
    ]

    expect(outline(getProjectGroupMoveTargetsForGroup(groups, groups[6]))).toEqual([
      'Acme',
      '  Infra',
      '  Web',
      'Personal',
      '  Web',
      '  Blog (disabled)'
    ])
  })

  it('hides parents that would push the moved subtree past three levels', () => {
    const levels = chain('level', 3)
    const moving = group('moving', { tabOrder: 1 })
    const groups = [...levels, moving, group('child', { parentGroupId: 'moving' })]

    expect(
      getProjectGroupMoveTargetsForGroup(groups, moving).map((target) => target.group.id)
    ).toEqual(['level1'])
  })

  it('offers only groups on the moving group host, even when ids repeat across hosts', () => {
    const local = [group('a'), group('b', { tabOrder: 1 })]
    const ssh = [group('ssh-root', { connectionId: 'conn-1', tabOrder: 2 })]
    const runtime = [
      group('a', { executionHostId: 'runtime:env-1' }),
      group('r', { executionHostId: 'runtime:env-1', tabOrder: 1 })
    ]
    const groups = [...local, ...ssh, ...runtime]

    expect(
      getProjectGroupMoveTargetsForGroup(groups, local[0]).map((target) => target.group.id)
    ).toEqual(['b'])
    expect(
      getProjectGroupMoveTargetsForGroup(groups, runtime[0]).map((target) => target.group.id)
    ).toEqual(['r'])
  })
})

describe('getProjectGroupMoveTargetsForProject', () => {
  const groups = [
    group('acme', { name: 'Acme' }),
    group('web', { name: 'Web', parentGroupId: 'acme' }),
    group('ssh-root', { name: 'Remote', connectionId: 'conn-1', tabOrder: 1 }),
    group('runtime-root', { name: 'Runtime', executionHostId: 'runtime:env-1' })
  ]

  it("lists the project's catalog as a tree with its current group disabled", () => {
    expect(
      outline(
        getProjectGroupMoveTargetsForProject(groups, {
          connectionId: 'conn-2',
          projectGroupId: 'web'
        })
      )
    ).toEqual(['Acme', '  Web (disabled)', 'Remote'])
  })

  it('keeps runtime projects inside their runtime host catalog', () => {
    expect(
      outline(
        getProjectGroupMoveTargetsForProject(groups, {
          executionHostId: 'runtime:env-1',
          projectGroupId: null
        })
      )
    ).toEqual(['Runtime'])
  })
})
