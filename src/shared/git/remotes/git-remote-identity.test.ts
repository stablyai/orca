import { describe, expect, it } from 'vitest'
import {
  deriveGitRemoteIdentity,
  matchGitRemoteKeyParts,
  normalizeGitRemoteUrl
} from './git-remote-identity'

describe('normalizeGitRemoteUrl', () => {
  it('preserves path case for case-sensitive hosted remotes', () => {
    expect(normalizeGitRemoteUrl('git@Git.Company.Test:Team/Sample-App.git')).toBe(
      'git.company.test/Team/Sample-App'
    )
    expect(normalizeGitRemoteUrl('https://git.company.test/Team/Sample-App.git')).toBe(
      'git.company.test/Team/Sample-App'
    )
  })

  it('rejects Windows local filesystem remotes', () => {
    expect(normalizeGitRemoteUrl('C:\\Repos\\sample-app.git')).toBeNull()
    expect(normalizeGitRemoteUrl('C:/Repos/sample-app.git')).toBeNull()
  })
})

describe('deriveGitRemoteIdentity', () => {
  it.each(['blob:none', 'blob:limit=1024', 'tree:0'])(
    'prefers a partial-clone origin with filter %s over contributor remotes',
    (filter) => {
      expect(
        deriveGitRemoteIdentity(
          [
            'amoaba\thttps://github.com/AmoabaKelvin/orca.git (fetch)',
            `origin\thttps://github.com/stablyai/orca.git (fetch) [${filter}]`,
            'origin\thttps://github.com/another/orca.git (push)'
          ].join('\r\n')
        )
      ).toEqual({
        canonicalKey: 'github.com/stablyai/orca',
        remoteName: 'origin',
        remoteUrl: 'https://github.com/stablyai/orca.git'
      })
    }
  )
})

describe('splitGitRemoteKey / matchGitRemoteKeyParts', () => {
  it('treats a dotless probed host as unknown but a real host as a mismatch', () => {
    const target = { host: 'github.com', tail: 'example/sample-app' }
    expect(matchGitRemoteKeyParts({ host: 'github-work', tail: target.tail }, target)).toBe(
      'unknown'
    )
    expect(matchGitRemoteKeyParts({ host: 'ghe.example.com', tail: target.tail }, target)).toBe(
      false
    )
    expect(matchGitRemoteKeyParts({ host: 'github-work', tail: 'other/repo' }, target)).toBe(false)
  })
})
