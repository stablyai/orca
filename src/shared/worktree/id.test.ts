import { describe, expect, it } from 'vitest'
import {
  getWorktreePathBasenameFromId,
  splitWorktreeId,
  splitWorktreeIdForFilesystem,
  worktreeIdentityKey,
  worktreeIdsEqual
} from './id'

describe('splitWorktreeId', () => {
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
  it('returns the real folder basename for folder workspace instance ids', () => {
    expect(
      getWorktreePathBasenameFromId(
        'repo-123::/abs/project::workspace:123e4567-e89b-12d3-a456-426614174000'
      )
    ).toBe('project')
  })
})

/** ID selectors must fold exactly the path spellings path: selectors fold (#16243). */
describe('worktreeIdentityKey path-spelling parity for id: selectors (#16243)', () => {
  const canonical = 'repo-123::/srv/workspaces/plugin'
  const key = (worktreeId: string): string => worktreeIdentityKey(worktreeId)

  it('folds the path spellings a `path:` selector already accepts', () => {
    expect(key('repo-123::/srv/workspaces/plugin/')).toBe(key(canonical))
    expect(key('repo-123::/srv//workspaces/plugin')).toBe(key(canonical))
    expect(key('repo-123::/srv/workspaces/Café'.normalize('NFD'))).toBe(
      key('repo-123::/srv/workspaces/Café'.normalize('NFC'))
    )
  })

  it('folds no more loosely than `path:` does', () => {
    // A leading `//` is a UNC root, not a doubled separator.
    expect(key('repo-123:://srv/workspaces/plugin')).not.toBe(key(canonical))
    // Dot segments are not canonicalized, so `id:` and `path:` still agree on refusing them.
    expect(key('repo-123::/srv/./workspaces/plugin')).not.toBe(key(canonical))
  })

  // Windows checkouts can be recorded with either separator (#15598, #15616).
  it('folds Windows separator and drive-letter case, as `path:` already does', () => {
    const windows = 'repo-123::D:/Agentic/game2'
    expect(key('repo-123::D:\\Agentic\\game2')).toBe(key(windows))
    expect(key('repo-123::d:/agentic/game2')).toBe(key(windows))
    // A backslash is a valid POSIX filename character, so a POSIX path never folds it.
    expect(key('repo-123::/srv\\workspaces')).not.toBe(key('repo-123::/srv/workspaces'))
    expect(key('repo-123::/srv/Workspaces')).not.toBe(key('repo-123::/srv/workspaces'))
  })

  it('keeps a UNC or WSL root distinct from a drive-letter location', () => {
    expect(key('repo-123:://server/share/game2')).not.toBe(key('repo-123::D:/server/share/game2'))
    expect(key('repo-123:://wsl.localhost/Ubuntu/home/dev/game2')).not.toBe(
      key('repo-123::D:/home/dev/game2')
    )
    // The two UNC aliases Windows exposes for one WSL distro are the same location.
    expect(key('repo-123:://wsl.localhost/Ubuntu/home/dev/game2')).toBe(
      key('repo-123:://wsl$/Ubuntu/home/dev/game2')
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

  it('keys a malformed id as itself, so it only ever matches itself', () => {
    for (const malformed of ['repo-a', 'repo-a::', '::/srv/a', '/srv/workspaces/plugin']) {
      expect(key(malformed)).toBe(malformed)
      expect(worktreeIdsEqual(malformed, malformed)).toBe(true)
    }
    expect(key('repo-a::')).not.toBe(key('repo-a::/'))
    expect(worktreeIdsEqual('repo-a::', 'repo-a::/')).toBe(false)
    expect(worktreeIdsEqual('::/srv/A/', '::/srv/A')).toBe(false)
  })
})
