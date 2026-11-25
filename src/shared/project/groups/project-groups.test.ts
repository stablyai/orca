import { describe, expect, it } from 'vitest'
import { normalizeProjectGroups } from './project-groups'

describe('normalizeProjectGroups', () => {
  it('keeps a group Claude account through a reload and drops a malformed one', () => {
    const [bound, malformed] = normalizeProjectGroups([
      {
        id: 'a',
        name: 'Axion',
        tabOrder: 0,
        claudeAccount: { kind: 'managed', accountId: 'ax-1' }
      },
      { id: 'b', name: 'Other', tabOrder: 1, claudeAccount: { kind: 'folder', configDir: 'C:/x' } }
    ])
    expect(bound?.claudeAccount).toEqual({ kind: 'managed', accountId: 'ax-1' })
    expect(malformed && 'claudeAccount' in malformed).toBe(false)
  })
})
