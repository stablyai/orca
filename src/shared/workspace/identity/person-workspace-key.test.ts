import { describe, expect, it } from 'vitest'
import {
  homeOfPersonWorkspace,
  isPersonWorkspaceKey,
  parsePersonWorkspaceKey,
  personWorkspaceKey
} from './person-workspace-key'
import { parseWorkspaceKey } from './workspace-scope'

describe('person workspace key', () => {
  it('round-trips parts holding the separator and escapes, and names no other workspace', () => {
    const ref = { folderWorkspaceId: 'home:1%2', botId: 'bot:%3A', accountId: 'usr_mate:x' }
    const key = personWorkspaceKey(ref)
    expect(parsePersonWorkspaceKey(key)).toEqual(ref)
    expect(homeOfPersonWorkspace(key)).toBe('folder:home:1%2')
    expect(personWorkspaceKey({ ...ref, accountId: 'usr_mate' })).not.toBe(key)
    expect(parseWorkspaceKey(key)).toBeNull()
    for (const malformed of ['person:a:b', 'person:a::c', 'person:%E0:b:c', 'folder:a', 'a:b:c']) {
      expect(isPersonWorkspaceKey(malformed)).toBe(false)
    }
  })
})
