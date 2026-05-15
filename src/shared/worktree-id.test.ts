import { describe, expect, it } from 'vitest'
import { WORKTREE_ID_SEPARATOR, getRepoIdFromWorktreeId, splitWorktreeId } from './worktree-id'

describe('WORKTREE_ID_SEPARATOR', () => {
  it('is the literal "::" separator', () => {
    expect(WORKTREE_ID_SEPARATOR).toBe('::')
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
})
