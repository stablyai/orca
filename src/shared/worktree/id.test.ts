import { describe, expect, it } from 'vitest'
import {
  WORKTREE_ID_SEPARATOR,
  getRepoIdFromWorktreeId,
  getRepoMainWorktreeId,
  getWorktreePathBasenameFromId,
  splitWorktreeId,
  splitWorktreeIdForFilesystem,
  worktreeIdComparisonKey
} from './id'

describe('WORKTREE_ID_SEPARATOR', () => {
  it('is the literal "::" separator', () => {
    expect(WORKTREE_ID_SEPARATOR).toBe('::')
  })
})

describe('getRepoMainWorktreeId', () => {
  it('round-trips through the id parsers on posix and Windows paths', () => {
    for (const repo of [
      { id: 'repo-123', path: '/abs/path' },
      { id: 'repo-123', path: 'C:\\Users\\me\\repo' }
    ]) {
      const worktreeId = getRepoMainWorktreeId(repo)
      expect(worktreeId).toBe(`${repo.id}${WORKTREE_ID_SEPARATOR}${repo.path}`)
      expect(splitWorktreeId(worktreeId)).toEqual({ repoId: repo.id, worktreePath: repo.path })
    }
  })
})

describe('getRepoIdFromWorktreeId', () => {
  it('returns the repo id for a canonical worktree id', () => {
    expect(getRepoIdFromWorktreeId('repo-123::/abs/path')).toBe('repo-123')
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

describe('splitWorktreeId', () => {
  it('splits a canonical worktree id into repo id and path', () => {
    expect(splitWorktreeId('repo-123::/abs/path')).toEqual({
      repoId: 'repo-123',
      worktreePath: '/abs/path'
    })
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

/**
 * #16243: the renderer can only address a workspace by `id:<repoId>::<path>`, so the key must fold
 * exactly the path spellings a `path:` selector already folds — and nothing more.
 */
describe('worktreeIdComparisonKey path-spelling parity for id: selectors (#16243)', () => {
  const canonical = 'repo-123::/srv/workspaces/plugin'
  const key = (worktreeId: string): string | null => worktreeIdComparisonKey(worktreeId)

  it('folds the path spellings a `path:` selector already accepts', () => {
    expect(key('repo-123::/srv/workspaces/plugin/')).toBe(key(canonical))
    expect(key('repo-123::/srv//workspaces/plugin')).toBe(key(canonical))
    expect(key('repo-123::/srv/workspaces/Café'.normalize('NFD'))).toBe(
      key('repo-123::/srv/workspaces/Café'.normalize('NFC'))
    )
  })

  it('folds no more loosely than `path:` does', () => {
    // A leading `//` is a UNC root, not a doubled separator.
    expect(key('repo-123://srv/workspaces/plugin')).not.toBe(key(canonical))
    // Dot segments are not canonicalized, so `id:` and `path:` still agree on refusing them.
    expect(key('repo-123::/srv/./workspaces/plugin')).not.toBe(key(canonical))
  })

  // #15598/#15616: the same Windows checkout is recorded with both separators.
  it('folds Windows separator and drive-letter case, as `path:` already does', () => {
    const windows = 'repo-123::D:/Agentic/game2'
    expect(key('repo-123::D:\\Agentic\\game2')).toBe(key(windows))
    expect(key('repo-123::d:/agentic/game2')).toBe(key(windows))
    // A backslash is a valid POSIX filename character, so a POSIX path never folds it.
    expect(key('repo-123::/srv\\workspaces')).not.toBe(key('repo-123::/srv/workspaces'))
    // POSIX roots stay case-sensitive.
    expect(key('repo-123::/srv/Workspaces')).not.toBe(key('repo-123::/srv/workspaces'))
  })

  it('keeps a UNC or WSL root distinct from a drive-letter location', () => {
    // Different roots naming different filesystems must never collapse into one key.
    expect(key('repo-123://server/share/game2')).not.toBe(key('repo-123::D:/server/share/game2'))
    expect(key('repo-123://wsl.localhost/Ubuntu/home/dev/game2')).not.toBe(
      key('repo-123::D:/home/dev/game2')
    )
    // The two UNC aliases Windows exposes for one WSL distro are the same location.
    expect(key('repo-123://wsl.localhost/Ubuntu/home/dev/game2')).toBe(
      key('repo-123://wsl$/Ubuntu/home/dev/game2')
    )
  })

  it('never merges different repos, workspaces, or folder sessions', () => {
    // STA-4343: the repo id stays exact, or a removal lands on a repo the caller never confirmed.
    expect(key('repo-999::/srv/workspaces/plugin')).not.toBe(key(canonical))
    expect(key('repo-123::/srv/workspaces/other')).not.toBe(key(canonical))
    expect(key('repo-a::/srv/folder::workspace:123e4567-e89b-12d3-a456-426614174000')).not.toBe(
      key('repo-a::/srv/folder::workspace:123e4567-e89b-12d3-a456-426614174001')
    )
  })

  it('returns null for ids with no repo boundary so callers keep exact matching', () => {
    expect(key('repo-a')).toBeNull()
    expect(key('repo-a::')).toBeNull()
    expect(key('/srv/workspaces/plugin')).toBeNull()
  })
})
