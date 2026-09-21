import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import {
  selectInheritedClaudeConfigDir,
  selectProjectGroupForHost
} from './project-group-claude-config-dir-selection'

function group(overrides: Partial<ProjectGroup> & { id: string }): ProjectGroup {
  return {
    name: overrides.id,
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

const PARENT = group({
  id: 'parent',
  name: 'Client Work',
  claudeConfigDir: '/home/alice/.claude-client'
})
const CHILD = group({ id: 'child', name: 'Child', parentGroupId: 'parent' })

describe('selectInheritedClaudeConfigDir', () => {
  it('names the ancestor group that supplied the binding', () => {
    expect(selectInheritedClaudeConfigDir([PARENT, CHILD], 'child')).toEqual({
      configDir: '/home/alice/.claude-client',
      groupId: 'parent',
      groupName: 'Client Work'
    })
  })

  it('still names the ancestor for a group that carries its own binding', () => {
    const bound = { ...CHILD, claudeConfigDir: '/home/alice/.claude-child' }
    expect(selectInheritedClaudeConfigDir([PARENT, bound], 'child')).toEqual({
      configDir: '/home/alice/.claude-client',
      groupId: 'parent',
      groupName: 'Client Work'
    })
  })

  it('returns null for a bound root group with no ancestor', () => {
    expect(selectInheritedClaudeConfigDir([PARENT], 'parent')).toBeNull()
  })

  it('returns null for an unbound tree', () => {
    expect(
      selectInheritedClaudeConfigDir([{ ...PARENT, claudeConfigDir: null }, CHILD], 'child')
    ).toBeNull()
  })

  it('ignores a same-id group stamped for a different execution host', () => {
    const otherHost = group({
      id: 'parent',
      name: 'Remote Client Work',
      executionHostId: 'runtime:env-1',
      claudeConfigDir: '/srv/alice/.claude'
    })
    const localChild = group({ id: 'child', parentGroupId: 'parent' })
    expect(
      selectInheritedClaudeConfigDir([otherHost, localChild], 'child', 'runtime:env-2')
    ).toBeNull()
  })
})

describe('selectProjectGroupForHost', () => {
  it('prefers the row stamped for the requested host', () => {
    const remote = group({
      id: 'child',
      name: 'Remote Child',
      executionHostId: 'runtime:env-1'
    })
    expect(selectProjectGroupForHost([CHILD, remote], 'child', 'runtime:env-1')?.name).toBe(
      'Remote Child'
    )
  })

  it('falls back to an unstamped legacy row', () => {
    expect(selectProjectGroupForHost([CHILD], 'child', 'runtime:env-1')?.name).toBe('Child')
  })

  it('never answers with a row stamped for a different host', () => {
    const remote = group({ id: 'child', executionHostId: 'runtime:env-1' })
    expect(selectProjectGroupForHost([remote], 'child', 'runtime:env-2')).toBeNull()
  })
})
