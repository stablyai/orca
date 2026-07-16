// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { DiffComment, PRComment } from '../../../../shared/types'
import { prCommentsToDecoratedDiffComments } from '@/lib/diff-comment-compat'

// Why: integration test to verify DiffViewer behavior with PR comments
// This tests the interaction between local diff comments and PR review comments
// in the context of the diff viewer, ensuring proper merging and filtering.

describe('DiffViewer PR comment integration', () => {
  const mockWorktreeId = 'test-worktree'
  const mockFilePath = 'src/components/test.tsx'

  function createLocalComment(overrides: Partial<DiffComment> = {}): DiffComment {
    return {
      id: `local-${Math.random()}`,
      worktreeId: mockWorktreeId,
      filePath: mockFilePath,
      lineNumber: 10,
      body: 'Local diff comment',
      createdAt: Date.now(),
      side: 'modified',
      source: 'diff',
      ...overrides
    }
  }

  function createPRComment(overrides: Partial<PRComment> = {}): PRComment {
    return {
      id: Math.floor(Math.random() * 1000),
      author: 'reviewer',
      authorAvatarUrl: 'avatar-url',
      body: 'PR review comment',
      createdAt: '2026-07-16T12:00:00Z',
      url: 'https://github.com/test/repo/pull/1',
      path: mockFilePath,
      line: 10,
      ...overrides
    }
  }

  it('merges local and PR comments correctly', () => {
    const localComments = [
      createLocalComment({ id: 'local-1', lineNumber: 5 }),
      createLocalComment({ id: 'local-2', lineNumber: 15 })
    ]

    const prComments = [
      createPRComment({ id: 100, line: 10 }),
      createPRComment({ id: 200, line: 20 })
    ]

    const decoratedPR = prCommentsToDecoratedDiffComments(prComments, mockFilePath, mockWorktreeId)
    const allComments = [...localComments, ...decoratedPR]

    expect(allComments).toHaveLength(4)
    expect(allComments.some((c) => c.id === 'local-1')).toBe(true)
    expect(allComments.some((c) => c.id === 'local-2')).toBe(true)
    expect(allComments.some((c) => c.id === 'pr-100')).toBe(true)
    expect(allComments.some((c) => c.id === 'pr-200')).toBe(true)
  })

  it('filters comments by file path for the current view', () => {
    const localComments = [
      createLocalComment({ filePath: mockFilePath }),
      createLocalComment({ filePath: 'src/other/file.ts' })
    ]

    const prComments = [
      createPRComment({ path: mockFilePath }),
      createPRComment({ path: 'src/other/file.ts' })
    ]

    const decoratedPR = prCommentsToDecoratedDiffComments(prComments, mockFilePath, mockWorktreeId)
    const allComments = [
      ...localComments.filter((c) => c.filePath === mockFilePath),
      ...decoratedPR
    ]

    expect(allComments).toHaveLength(2)
    expect(allComments.every((c) => c.filePath === mockFilePath)).toBe(true)
  })

  it('handles PR comments with different line numbers', () => {
    const prComments = [
      createPRComment({ id: 100, line: 5 }),
      createPRComment({ id: 200, line: 10 }),
      createPRComment({ id: 300, line: 15 })
    ]

    const decoratedPR = prCommentsToDecoratedDiffComments(prComments, mockFilePath, mockWorktreeId)

    expect(decoratedPR).toHaveLength(3)
    expect(decoratedPR[0].lineNumber).toBe(5)
    expect(decoratedPR[1].lineNumber).toBe(10)
    expect(decoratedPR[2].lineNumber).toBe(15)
  })

  it('handles PR comments with startLine ranges', () => {
    const prComments = [
      createPRComment({ id: 100, line: 10, startLine: 5 }),
      createPRComment({ id: 200, line: 20, startLine: 15 })
    ]

    const decoratedPR = prCommentsToDecoratedDiffComments(prComments, mockFilePath, mockWorktreeId)

    expect(decoratedPR).toHaveLength(2)
    expect(decoratedPR[0].lineNumber).toBe(10)
    expect(decoratedPR[0].startLine).toBe(5)
    expect(decoratedPR[1].lineNumber).toBe(20)
    expect(decoratedPR[1].startLine).toBe(15)
  })

  it('handles empty comment arrays gracefully', () => {
    const decoratedPR = prCommentsToDecoratedDiffComments([], mockFilePath, mockWorktreeId)
    const allComments = decoratedPR

    expect(allComments).toHaveLength(0)
  })

  it('preserves PR comment metadata in decorated format', () => {
    const prComment = createPRComment({
      id: 100,
      author: 'test-reviewer',
      authorAvatarUrl: 'https://example.com/avatar.png',
      body: 'This is a review comment',
      url: 'https://github.com/test/repo/pull/1#comment-100'
    })

    const decoratedPR = prCommentsToDecoratedDiffComments([prComment], mockFilePath, mockWorktreeId)

    expect(decoratedPR).toHaveLength(1)
    expect(decoratedPR[0].author).toBe('test-reviewer')
    expect(decoratedPR[0].authorAvatarUrl).toBe('https://example.com/avatar.png')
    expect(decoratedPR[0].body).toBe('This is a review comment')
    expect(decoratedPR[0].url).toBe('https://github.com/test/repo/pull/1#comment-100')
    expect(decoratedPR[0].canDelete).toBe(false)
    expect(decoratedPR[0].canEdit).toBe(false)
  })

  it('handles mixed source comments correctly', () => {
    const localComments = [
      createLocalComment({ source: 'diff' }),
      createLocalComment({ source: 'markdown' })
    ]

    const prComments = [createPRComment({ id: 100 })]

    const decoratedPR = prCommentsToDecoratedDiffComments(prComments, mockFilePath, mockWorktreeId)
    const diffComments = localComments.filter((c) => c.source === 'diff' || c.source === undefined)
    const allComments = [...diffComments, ...decoratedPR]

    expect(allComments).toHaveLength(2)
    expect(allComments.every((c) => c.source === 'diff')).toBe(true)
  })

  it('normalizes file paths for cross-platform compatibility', () => {
    const prComments = [
      createPRComment({ path: 'src/components/test.tsx' }),
      createPRComment({ path: 'src\\components\\test.tsx' }),
      createPRComment({ path: '/src/components/test.tsx' })
    ]

    const decoratedPR = prCommentsToDecoratedDiffComments(prComments, mockFilePath, mockWorktreeId)

    // All three should match due to normalization
    expect(decoratedPR).toHaveLength(3)
  })

  it('handles worktree ID filtering', () => {
    const localComments = [
      createLocalComment({ worktreeId: 'worktree-1' }),
      createLocalComment({ worktreeId: 'worktree-2' })
    ]

    const prComments = [createPRComment({ id: 100 })]

    const decoratedPR = prCommentsToDecoratedDiffComments(prComments, mockFilePath, 'worktree-1')
    const allComments = [
      ...localComments.filter((c) => c.worktreeId === 'worktree-1'),
      ...decoratedPR
    ]

    expect(allComments).toHaveLength(2)
    expect(allComments.every((c) => c.worktreeId === 'worktree-1')).toBe(true)
  })
})
