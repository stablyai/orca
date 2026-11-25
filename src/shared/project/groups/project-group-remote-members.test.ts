import { describe, expect, it } from 'vitest'
import { normalizeProjectGroups } from './project-groups'

const base = { createdAt: 1, updatedAt: 1, tabOrder: 0, parentPath: null, connectionId: null }

describe('project group remote members persistence', () => {
  it('loads groups saved before remote members existed without adding the field', () => {
    const [group] = normalizeProjectGroups([{ ...base, id: 'old', name: 'Old' }])
    expect(group).not.toHaveProperty('remoteMembers')
  })

  it('keeps valid remote members across a save and reload, dropping invalid and duplicate ones', () => {
    const saved = [
      {
        ...base,
        id: 'work',
        name: 'Work',
        remoteMembers: [
          { hostId: 'runtime:vps', projectId: 'api', order: 2 },
          { hostId: 'runtime:vps', projectId: 'web', order: Number.NaN },
          { hostId: 'local', projectId: 'mine' },
          { hostId: 'ssh:box', projectId: 'tunnel' },
          { hostId: 'runtime:vps', projectId: '' },
          { hostId: 'runtime:vps', projectId: 'api' },
          'garbage'
        ]
      },
      {
        ...base,
        id: 'later',
        name: 'Later',
        tabOrder: 1,
        remoteMembers: [
          { hostId: 'runtime:vps', projectId: 'api' },
          { hostId: 'runtime:pc', projectId: 'api' }
        ]
      }
    ]
    const loaded = normalizeProjectGroups(saved)
    expect(loaded.map((group) => group.remoteMembers)).toEqual([
      [
        { hostId: 'runtime:vps', projectId: 'api', order: 2 },
        { hostId: 'runtime:vps', projectId: 'web' }
      ],
      [{ hostId: 'runtime:pc', projectId: 'api' }]
    ])
    expect(normalizeProjectGroups(JSON.parse(JSON.stringify(loaded)))).toEqual(loaded)
  })
})
