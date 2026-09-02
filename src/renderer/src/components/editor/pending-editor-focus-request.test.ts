import { describe, expect, it } from 'vitest'
import type { PendingEditorFocusRequest } from '@/store/slices/editor'
import { matchesPendingEditorFocusRequest } from './pending-editor-focus-request'

const request: PendingEditorFocusRequest = {
  fileId: 'file-1',
  worktreeId: 'worktree-1',
  viewStateId: 'view-1',
  expiresAt: 0,
  token: 3
}

const pane = { fileId: 'file-1', worktreeId: 'worktree-1', viewStateId: 'view-1' }

describe('matchesPendingEditorFocusRequest', () => {
  it('matches the pane the handoff was opened into', () => {
    expect(matchesPendingEditorFocusRequest(request, pane)).toBe(true)
  })

  it('rejects a missing request', () => {
    expect(matchesPendingEditorFocusRequest(null, pane)).toBe(false)
    expect(matchesPendingEditorFocusRequest(undefined, pane)).toBe(false)
  })

  it('rejects a split sibling showing the same file', () => {
    expect(matchesPendingEditorFocusRequest(request, { ...pane, viewStateId: 'view-2' })).toBe(
      false
    )
  })

  it('rejects the same pane id in another file or worktree', () => {
    expect(matchesPendingEditorFocusRequest(request, { ...pane, fileId: 'file-2' })).toBe(false)
    expect(matchesPendingEditorFocusRequest(request, { ...pane, worktreeId: 'worktree-2' })).toBe(
      false
    )
  })

  it('rejects a pane that cannot identify itself', () => {
    // Why: surfaces that omit the props must never swallow another pane's handoff.
    expect(matchesPendingEditorFocusRequest(request, { ...pane, viewStateId: undefined })).toBe(
      false
    )
    expect(matchesPendingEditorFocusRequest(request, { ...pane, worktreeId: undefined })).toBe(
      false
    )
  })
})
