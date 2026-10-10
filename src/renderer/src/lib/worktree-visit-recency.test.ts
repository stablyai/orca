import { describe, expect, it } from 'vitest'
import {
  getWorktreeVisitKey,
  getWorktreeVisitTimestamp,
  removeWorktreeVisitEntries
} from './worktree-visit-recency'

describe('worktree visit recency identities', () => {
  it('keeps same-id host twins independent when reading and writing keys', () => {
    const id = 'repo::/srv/app'
    const localKey = getWorktreeVisitKey(id, 'local')
    const sshKey = getWorktreeVisitKey(id, 'ssh:builder')
    const timestamps = { [localKey]: 100, [sshKey]: 200 }

    expect(localKey).toBe(`local|${id}`)
    expect(sshKey).toBe(`ssh:builder|${id}`)
    expect(getWorktreeVisitTimestamp(timestamps, { id, hostId: 'local' })).toBe(100)
    expect(getWorktreeVisitTimestamp(timestamps, { id, hostId: 'ssh:builder' })).toBe(200)
  })

  it('falls back to a legacy bare key only when the host key is absent', () => {
    const id = 'repo::/srv/app'
    expect(getWorktreeVisitTimestamp({ [id]: 100 }, { id, hostId: 'ssh:builder' })).toBe(100)
    expect(
      getWorktreeVisitTimestamp(
        { [id]: 100, [getWorktreeVisitKey(id, 'ssh:builder')]: 200 },
        { id, hostId: 'ssh:builder' }
      )
    ).toBe(200)
  })

  it('removes one host key without deleting the other host twin or legacy fallback', () => {
    const id = 'repo::/srv/app'
    const timestamps = {
      [id]: 50,
      [getWorktreeVisitKey(id, 'local')]: 100,
      [getWorktreeVisitKey(id, 'ssh:builder')]: 200
    }
    expect(removeWorktreeVisitEntries(timestamps, new Set([id]), 'local')).toEqual({
      [id]: 50,
      [getWorktreeVisitKey(id, 'ssh:builder')]: 200
    })
  })
})
