import { describe, expect, it } from 'vitest'
import {
  getWorktreeVisitKey,
  getWorktreeVisitTimestamp,
  rekeyWorktreeVisitHost,
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

describe('rekeyWorktreeVisitHost', () => {
  const id = 'repo::/srv/app'

  it('moves one host’s visits to the host that now runs its workspaces, newer visit winning', () => {
    const moved = rekeyWorktreeVisitHost(
      {
        [getWorktreeVisitKey(id, 'ssh:box')]: 300,
        [getWorktreeVisitKey(id, 'runtime:env')]: 100,
        [getWorktreeVisitKey('repo::/srv/other', 'ssh:box')]: 50,
        [getWorktreeVisitKey(id, 'ssh:box-2')]: 70,
        [getWorktreeVisitKey(id, 'local')]: 20,
        [id]: 10
      },
      'ssh:box',
      'runtime:env'
    )
    expect(moved).toEqual({
      [getWorktreeVisitKey(id, 'runtime:env')]: 300,
      [getWorktreeVisitKey('repo::/srv/other', 'runtime:env')]: 50,
      [getWorktreeVisitKey(id, 'ssh:box-2')]: 70,
      [getWorktreeVisitKey(id, 'local')]: 20,
      [id]: 10
    })
  })

  it('returns the same map when the host has no visits', () => {
    const timestamps = { [getWorktreeVisitKey(id, 'local')]: 1 }
    expect(rekeyWorktreeVisitHost(timestamps, 'ssh:box', 'runtime:env')).toBe(timestamps)
  })
})
