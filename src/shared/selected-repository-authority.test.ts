import { describe, expect, it } from 'vitest'
import { resolveSelectedRepositoryAuthority } from './selected-repository-authority'

type Candidate = {
  id: string
  path: string
  connectionId?: string | null
}

describe('selected repository authority', () => {
  it('leaves legacy selection unchanged when authority is omitted', () => {
    const candidates: Candidate[] = [
      { id: 'local', path: '/repo' },
      { id: 'ssh', path: '/repo', connectionId: 'builder' }
    ]

    expect(resolveSelectedRepositoryAuthority(candidates)).toEqual({
      status: 'legacy-selection'
    })
  })

  it('returns the exact path and connection owner', () => {
    const local = { id: 'local', path: '/repo' }
    const ssh = { id: 'ssh', path: '/repo', connectionId: 'builder' }

    const resolution = resolveSelectedRepositoryAuthority([local, ssh], {
      path: '/repo',
      connectionId: 'builder'
    })

    expect(resolution).toEqual({ status: 'resolved', candidate: ssh })
    if (resolution.status === 'resolved') {
      expect(resolution.candidate).toBe(ssh)
    }
  })

  it('uses cross-platform path comparison and trims connection ids', () => {
    const candidate = {
      id: 'windows-ssh',
      path: 'C:\\Repos\\Orca',
      connectionId: ' builder '
    }

    expect(
      resolveSelectedRepositoryAuthority([candidate], {
        path: 'c:/repos/orca/',
        connectionId: 'builder'
      })
    ).toEqual({ status: 'resolved', candidate })
  })

  it('normalizes missing and blank connection ids to the local owner', () => {
    const candidate = { id: 'local', path: '/repo', connectionId: undefined }

    expect(
      resolveSelectedRepositoryAuthority([candidate], {
        path: '/repo/',
        connectionId: null
      })
    ).toEqual({ status: 'resolved', candidate })
    expect(
      resolveSelectedRepositoryAuthority([{ ...candidate, connectionId: '  ' }], {
        path: '/repo',
        connectionId: null
      })
    ).toMatchObject({ status: 'resolved' })
  })

  it('fails closed when no candidate has the selected authority', () => {
    expect(
      resolveSelectedRepositoryAuthority([{ id: 'local', path: '/repo' }], {
        path: '/repo',
        connectionId: 'builder'
      })
    ).toEqual({ status: 'rejected', reason: 'no-match', matchCount: 0 })
  })

  it('fails closed when multiple candidates have the selected authority', () => {
    const authority = { path: '/repo', connectionId: 'builder' }
    const candidates = [
      { id: 'first', ...authority },
      { id: 'second', path: '/repo/', connectionId: ' builder ' }
    ]

    expect(resolveSelectedRepositoryAuthority(candidates, authority)).toEqual({
      status: 'rejected',
      reason: 'ambiguous',
      matchCount: 2
    })
  })

  it('keeps POSIX paths case-sensitive', () => {
    expect(
      resolveSelectedRepositoryAuthority(
        [{ id: 'case-distinct', path: '/srv/Orca', connectionId: 'builder' }],
        { path: '/srv/orca', connectionId: 'builder' }
      )
    ).toEqual({ status: 'rejected', reason: 'no-match', matchCount: 0 })
  })
})
