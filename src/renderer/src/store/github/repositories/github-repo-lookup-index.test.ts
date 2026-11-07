import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import { getGitHubRepoLookupIndex } from './github-repo-lookup-index'

function makeRepo(id: string, path: string): Repo {
  return { id, path, displayName: id, badgeColor: 'blue', addedAt: 1, kind: 'git' }
}

describe('getGitHubRepoLookupIndex', () => {
  it('matches Array.find ordering for combined ID and path lookups', () => {
    const pathMatch = makeRepo('other', '/target')
    const idMatch = makeRepo('target', '/other')
    const lookup = getGitHubRepoLookupIndex([pathMatch, idMatch])

    expect(lookup.findByIdOrPath('target', '/target')).toBe(pathMatch)
  })

  it('picks the twin at the requested path over an earlier row with the same id', () => {
    const localTwin = makeRepo('twin', '/laptop/twin')
    const sshTwin = { ...makeRepo('twin', '/remote/twin'), connectionId: 'builder' }
    const lookup = getGitHubRepoLookupIndex([localTwin, sshTwin])

    expect(lookup.findByIdOrPath('twin', '/remote/twin')).toBe(sshTwin)
    expect(lookup.findByIdOrPath('twin', '/laptop/twin')).toBe(localTwin)
    expect(lookup.findByIdOrPath('twin', '/elsewhere')).toBe(localTwin)
  })
})
