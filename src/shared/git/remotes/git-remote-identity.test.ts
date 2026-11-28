import { expect, it } from 'vitest'
import {
  deriveGitRemoteIdentity,
  matchGitRemoteKeyParts,
  normalizeGitRemoteUrl
} from './git-remote-identity'

it('keeps a bracketed IPv6 SCP host intact when deriving repository identity', () => {
  const key = '[2001:db8::1]/team/repo'
  expect(normalizeGitRemoteUrl('git@[2001:db8::1]:team/repo.git')).toBe(key)
  expect(normalizeGitRemoteUrl('[2001:0db8:0:0:0:0:0:1]:team/repo.git')).toBe(key)
  expect(normalizeGitRemoteUrl('ssh://git@[2001:db8::1]/team/repo.git')).toBe(key)
  expect(deriveGitRemoteIdentity('origin\tgit@[2001:db8::1]:team/repo.git (fetch)\n')).toEqual({
    canonicalKey: key,
    remoteName: 'origin',
    remoteUrl: 'git@[2001:db8::1]:team/repo.git'
  })
  expect(normalizeGitRemoteUrl('git@example.test:team/repo.git')).toBe('example.test/team/repo')
  expect(normalizeGitRemoteUrl('git@example.test:team/repo://archive.git')).toBe(
    'example.test/team/repo://archive'
  )
  expect(normalizeGitRemoteUrl('C:\\repos\\repo.git')).toBeNull()
})

it('rejects a bracketed IPv6 host mismatch without resolving ordinary SSH aliases', () => {
  const identity = { host: '[2001:db8::1]', tail: 'team/repo' }
  const target = { host: 'github.com', tail: 'team/repo' }

  expect(matchGitRemoteKeyParts(identity, target)).toBe(false)
  expect(matchGitRemoteKeyParts(identity, { ...target, host: '[2001:db8::2]' })).toBe(false)
  expect(matchGitRemoteKeyParts(identity, identity)).toBe(true)
  expect(matchGitRemoteKeyParts({ ...identity, host: 'work' }, target)).toBe('unknown')
})
