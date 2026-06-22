import { describe, expect, it } from 'vitest'
import {
  WORKTREE_ID_SEPARATOR,
  getRepoIdFromWorktreeId,
  getWorktreePathBasenameFromId,
  isLegacyWorktreeId,
  makeRepoWorktreeKey,
  makeWorktreeKey,
  parseAnyWorktreeId,
  parseWorktreeKey,
  splitWorktreeId,
  splitWorktreeIdForFilesystem
} from './worktree-id'

describe('WORKTREE_ID_SEPARATOR', () => {
  it('is the literal "::" separator', () => {
    expect(WORKTREE_ID_SEPARATOR).toBe('::')
  })
})

describe('getRepoIdFromWorktreeId', () => {
  it('returns the repo id for a canonical worktree id', () => {
    expect(getRepoIdFromWorktreeId('repo-123::/abs/path')).toBe('repo-123')
  })

  it('returns the repo id for a host-qualified worktree key', () => {
    expect(
      getRepoIdFromWorktreeId(
        makeWorktreeKey({ hostId: 'runtime:gpu', repoId: 'repo-123', path: '/abs/path' })
      )
    ).toBe('repo-123')
  })

  it('returns the whole input when there is no separator', () => {
    expect(getRepoIdFromWorktreeId('just-a-repo-id')).toBe('just-a-repo-id')
  })

  it('returns the empty string for an empty input', () => {
    expect(getRepoIdFromWorktreeId('')).toBe('')
  })

  it('returns an empty repo id for a bare separator', () => {
    expect(getRepoIdFromWorktreeId('::')).toBe('')
  })

  it('returns an empty repo id for a leading separator', () => {
    expect(getRepoIdFromWorktreeId('::path')).toBe('')
  })

  it('returns the repo id when only a trailing separator is present', () => {
    expect(getRepoIdFromWorktreeId('repo::')).toBe('repo')
  })

  it('splits on the first separator when the path itself contains "::"', () => {
    expect(getRepoIdFromWorktreeId('repo::a::b')).toBe('repo')
  })
})

describe('makeWorktreeKey', () => {
  it('creates a canonical host-qualified key with stable parameter order', () => {
    expect(
      makeWorktreeKey({ hostId: 'local', repoId: 'repo-123', path: '/Users/alice/orca' })
    ).toBe('orca-worktree://v1?hostId=local&repoId=repo-123&path=%2FUsers%2Falice%2Forca')
  })

  it('encodes host ids, repo ids, POSIX paths, and Windows paths without delimiter collisions', () => {
    const key = makeWorktreeKey({
      hostId: 'ssh:openclaw%202',
      repoId: 'repo::with spaces',
      path: 'C:\\Users\\Alice\\repo::workspace'
    })

    expect(parseWorktreeKey(key)).toEqual({
      hostId: 'ssh:openclaw%202',
      repoId: 'repo::with spaces',
      worktreePath: 'C:\\Users\\Alice\\repo::workspace'
    })
  })

  it('builds keys from repo execution ownership', () => {
    expect(
      makeRepoWorktreeKey(
        { id: 'repo-123', connectionId: null, executionHostId: 'runtime:gpu' },
        '/srv/repo'
      )
    ).toBe('orca-worktree://v1?hostId=runtime%3Agpu&repoId=repo-123&path=%2Fsrv%2Frepo')
  })
})

describe('parseWorktreeKey', () => {
  it('parses a valid canonical key', () => {
    expect(
      parseWorktreeKey('orca-worktree://v1?hostId=runtime%3Agpu&repoId=repo-123&path=%2Fsrv%2Frepo')
    ).toEqual({ hostId: 'runtime:gpu', repoId: 'repo-123', worktreePath: '/srv/repo' })
  })

  it('rejects legacy ids', () => {
    expect(parseWorktreeKey('repo-123::/abs/path')).toBeNull()
  })

  it('rejects missing, empty, duplicate, reordered, and unknown fields', () => {
    expect(parseWorktreeKey('orca-worktree://v1?hostId=local&repoId=repo')).toBeNull()
    expect(parseWorktreeKey('orca-worktree://v1?hostId=local&repoId=repo&path=')).toBeNull()
    expect(
      parseWorktreeKey('orca-worktree://v1?hostId=local&repoId=repo&path=%2Fx&path=%2Fy')
    ).toBeNull()
    expect(parseWorktreeKey('orca-worktree://v1?repoId=repo&hostId=local&path=%2Fx')).toBeNull()
    expect(
      parseWorktreeKey('orca-worktree://v1?hostId=local&repoId=repo&path=%2Fx&extra=1')
    ).toBeNull()
  })

  it('rejects unknown versions and invalid hosts', () => {
    expect(parseWorktreeKey('orca-worktree://v2?hostId=local&repoId=repo&path=%2Fx')).toBeNull()
    expect(parseWorktreeKey('orca-worktree://v1?hostId=bogus&repoId=repo&path=%2Fx')).toBeNull()
  })
})

describe('parseAnyWorktreeId', () => {
  it('distinguishes canonical and legacy ids', () => {
    const canonical = makeWorktreeKey({ hostId: 'local', repoId: 'repo-123', path: '/abs/path' })

    expect(parseAnyWorktreeId(canonical)).toEqual({
      format: 'canonical',
      hostId: 'local',
      repoId: 'repo-123',
      worktreePath: '/abs/path'
    })
    expect(parseAnyWorktreeId('repo-123::/abs/path')).toEqual({
      format: 'legacy',
      repoId: 'repo-123',
      worktreePath: '/abs/path'
    })
  })
})

describe('isLegacyWorktreeId', () => {
  it('returns true only for legacy ids', () => {
    expect(isLegacyWorktreeId('repo-123::/abs/path')).toBe(true)
    expect(
      isLegacyWorktreeId(
        makeWorktreeKey({ hostId: 'local', repoId: 'repo-123', path: '/abs/path' })
      )
    ).toBe(false)
    expect(isLegacyWorktreeId('repo-123')).toBe(false)
  })
})

describe('splitWorktreeId', () => {
  it('splits a canonical worktree id into repo id and path', () => {
    expect(splitWorktreeId('repo-123::/abs/path')).toEqual({
      repoId: 'repo-123',
      worktreePath: '/abs/path'
    })
  })

  it('splits a host-qualified worktree key into host, repo id, and path', () => {
    expect(
      splitWorktreeId(makeWorktreeKey({ hostId: 'local', repoId: 'repo-123', path: '/abs/path' }))
    ).toEqual({ hostId: 'local', repoId: 'repo-123', worktreePath: '/abs/path' })
  })

  it('returns null when there is no separator', () => {
    expect(splitWorktreeId('just-a-repo-id')).toBeNull()
  })

  it('returns null for an empty input', () => {
    expect(splitWorktreeId('')).toBeNull()
  })

  it('returns empty repo id and empty path for a bare separator', () => {
    expect(splitWorktreeId('::')).toEqual({ repoId: '', worktreePath: '' })
  })

  it('returns an empty repo id when the separator is leading', () => {
    expect(splitWorktreeId('::path')).toEqual({ repoId: '', worktreePath: 'path' })
  })

  it('returns an empty path when the separator is trailing', () => {
    expect(splitWorktreeId('repo::')).toEqual({ repoId: 'repo', worktreePath: '' })
  })

  it('splits on the first separator when the path itself contains "::"', () => {
    expect(splitWorktreeId('repo::a::b')).toEqual({ repoId: 'repo', worktreePath: 'a::b' })
  })

  it('preserves folder workspace instance suffixes in the literal parsed path', () => {
    expect(
      splitWorktreeId('repo::/folder::workspace:123e4567-e89b-12d3-a456-426614174000')
    ).toEqual({
      repoId: 'repo',
      worktreePath: '/folder::workspace:123e4567-e89b-12d3-a456-426614174000'
    })
  })
})

describe('splitWorktreeIdForFilesystem', () => {
  it('strips folder workspace instance suffixes from the parsed path', () => {
    expect(
      splitWorktreeIdForFilesystem('repo::/folder::workspace:123e4567-e89b-12d3-a456-426614174000')
    ).toEqual({ repoId: 'repo', worktreePath: '/folder' })
  })

  it('strips folder workspace instance suffixes from host-qualified keys', () => {
    expect(
      splitWorktreeIdForFilesystem(
        makeWorktreeKey({
          hostId: 'local',
          repoId: 'repo',
          path: '/folder::workspace:123e4567-e89b-12d3-a456-426614174000'
        })
      )
    ).toEqual({ hostId: 'local', repoId: 'repo', worktreePath: '/folder' })
  })
})

describe('getWorktreePathBasenameFromId', () => {
  it('returns the path basename for POSIX worktree ids', () => {
    expect(getWorktreePathBasenameFromId('repo-123::/abs/path/nightly-checks')).toBe(
      'nightly-checks'
    )
  })

  it('returns the path basename for Windows worktree ids', () => {
    expect(getWorktreePathBasenameFromId('repo-123::C:\\workspaces\\nightly-checks')).toBe(
      'nightly-checks'
    )
  })

  it('returns the real folder basename for folder workspace instance ids', () => {
    expect(
      getWorktreePathBasenameFromId(
        'repo-123::/abs/project::workspace:123e4567-e89b-12d3-a456-426614174000'
      )
    ).toBe('project')
  })

  it('returns null when no worktree path is available', () => {
    expect(getWorktreePathBasenameFromId('repo-123')).toBeNull()
    expect(getWorktreePathBasenameFromId('repo-123::')).toBeNull()
  })
})
