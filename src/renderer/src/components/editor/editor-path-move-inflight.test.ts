import { afterEach, describe, expect, it } from 'vitest'
import {
  __activeEditorPathMoveCountForTests,
  __clearEditorPathMovesForTests,
  beginEditorPathMove,
  isActiveMoveSourcePath,
  settleEditorPathMove
} from './editor-path-move-inflight'

describe('editor-path-move-inflight', () => {
  afterEach(() => __clearEditorPathMovesForTests())

  it('marks a source path active only while the operation is in flight', () => {
    beginEditorPathMove({
      operationId: 'op-1',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      sourcePaths: ['/repo/a.md']
    })
    expect(isActiveMoveSourcePath('wt-1', null, '/repo/a.md')).toBe(true)

    settleEditorPathMove('op-1')
    expect(isActiveMoveSourcePath('wt-1', null, '/repo/a.md')).toBe(false)
    expect(__activeEditorPathMoveCountForTests()).toBe(0)
  })

  it('prefix-matches a root so a file opened under a moving directory is suppressed', () => {
    beginEditorPathMove({
      operationId: 'op-1',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      sourcePaths: ['/repo/src']
    })
    // The exact root, and a file that appeared under it mid-move, are both echoes.
    expect(isActiveMoveSourcePath('wt-1', null, '/repo/src')).toBe(true)
    expect(isActiveMoveSourcePath('wt-1', null, '/repo/src/late.ts')).toBe(true)
    // A sibling outside the root is a genuine external delete.
    expect(isActiveMoveSourcePath('wt-1', null, '/repo/srcabc.ts')).toBe(false)
    expect(isActiveMoveSourcePath('wt-1', null, '/repo/other.ts')).toBe(false)
  })

  it('scopes by worktree and runtime owner', () => {
    beginEditorPathMove({
      operationId: 'op-1',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: 'env-1',
      sourcePaths: ['/repo/a.md']
    })
    expect(isActiveMoveSourcePath('wt-1', 'env-1', '/repo/a.md')).toBe(true)
    expect(isActiveMoveSourcePath('wt-1', null, '/repo/a.md')).toBe(false)
    expect(isActiveMoveSourcePath('wt-2', 'env-1', '/repo/a.md')).toBe(false)
  })

  it('keeps concurrent operations independent (settling one leaves the other)', () => {
    beginEditorPathMove({
      operationId: 'op-1',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      sourcePaths: ['/repo/a.md']
    })
    beginEditorPathMove({
      operationId: 'op-2',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: null,
      sourcePaths: ['/repo/b.md']
    })

    settleEditorPathMove('op-1')
    expect(isActiveMoveSourcePath('wt-1', null, '/repo/a.md')).toBe(false)
    expect(isActiveMoveSourcePath('wt-1', null, '/repo/b.md')).toBe(true)
  })
})
