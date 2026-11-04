import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
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

  it('scans each repo once across repeated misses', () => {
    let idReads = 0
    const repos = Array.from({ length: 32 }, (_, index) => {
      const repo = makeRepo(`repo-${index}`, `/repo-${index}`)
      return Object.defineProperty(repo, 'id', {
        configurable: true,
        enumerable: true,
        get: () => {
          idReads += 1
          return `repo-${index}`
        }
      })
    })
    const lookup = getGitHubRepoLookupIndex(repos)

    expect(lookup.findById('missing-first')).toBeUndefined()
    expect(lookup.findById('missing-second')).toBeUndefined()
    expect(idReads).toBe(repos.length)
  })
})
