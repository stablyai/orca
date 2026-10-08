// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../shared/diff-comment-types'

const store = vi.hoisted(() => {
  const state: { settings: { markdownReviewToolsEnabled: boolean }; comments: DiffComment[] } = {
    settings: { markdownReviewToolsEnabled: true },
    comments: []
  }
  return state
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ settings: store.settings })
}))
vi.mock('@/store/worktree-diff-comments-selector', () => ({
  selectWorktreeDiffCommentsOrEmpty: () => store.comments
}))

import { useVisibleWorktreeDiffComments } from './use-visible-worktree-diff-comments'

function note(id: string, source?: DiffComment['source']): DiffComment {
  return {
    id,
    worktreeId: 'wt-1',
    filePath: 'README.md',
    lineNumber: 1,
    body: id,
    createdAt: 0,
    side: 'modified',
    ...(source ? { source } : {})
  }
}

describe('useVisibleWorktreeDiffComments', () => {
  store.comments = [note('diff'), note('md', 'markdown')]

  it('includes markdown notes while the setting is on', () => {
    store.settings = { markdownReviewToolsEnabled: true }
    const { result } = renderHook(() => useVisibleWorktreeDiffComments('wt-1'))
    expect(result.current.markdownReviewNotesEnabled).toBe(true)
    expect(result.current.comments.map((c) => c.id)).toEqual(['diff', 'md'])
  })

  it('leaves markdown notes out of lists and send menus while the setting is off', () => {
    store.settings = { markdownReviewToolsEnabled: false }
    const { result } = renderHook(() => useVisibleWorktreeDiffComments('wt-1'))
    expect(result.current.markdownReviewNotesEnabled).toBe(false)
    expect(result.current.comments.map((c) => c.id)).toEqual(['diff'])
  })
})
