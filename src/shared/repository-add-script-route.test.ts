import { describe, expect, it } from 'vitest'
import type { Repo } from './repo-types'
import { keepRequestedRepositoryAddScriptPreview } from './repository-add-script-route'
import type { RepositoryAddScriptPreview } from './repository-add-script-types'

const repo: Repo = {
  id: 'r1',
  path: '/work/r1',
  displayName: 'r1',
  badgeColor: '',
  addedAt: 1,
  kind: 'git'
}
const preview: RepositoryAddScriptPreview = {
  token: 'tok',
  hostId: 'runtime:env-1',
  hostLabel: 'Studio',
  repoId: 'r1',
  path: '/work/r1',
  target: { kind: 'native', cwd: '/work/r1' },
  script: 'echo hi',
  scriptHash: 'hash'
}

describe('keepRequestedRepositoryAddScriptPreview', () => {
  it('keeps an offer for the requested host and the registered repo', () => {
    const result = { repo, repositoryAddScriptPreview: preview }

    expect(keepRequestedRepositoryAddScriptPreview(result, 'runtime:env-1')).toBe(result)
  })

  it('drops an offer for another repo and removes the key', () => {
    const kept = keepRequestedRepositoryAddScriptPreview(
      { repo, repositoryAddScriptPreview: { ...preview, repoId: 'r2' } },
      'runtime:env-1'
    )

    expect(kept).toEqual({ repo })
    expect('repositoryAddScriptPreview' in kept).toBe(false)
  })

  it('drops an offer for another host', () => {
    const kept = keepRequestedRepositoryAddScriptPreview(
      { repo, repositoryAddScriptPreview: preview },
      'runtime:env-2'
    )

    expect('repositoryAddScriptPreview' in kept).toBe(false)
  })
})
