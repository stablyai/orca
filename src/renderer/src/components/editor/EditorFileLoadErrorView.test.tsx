// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'
import {
  FILE_TOO_LARGE_CODE,
  FILE_TOO_LARGE_ERROR,
  WORKTREE_HOST_UNRESOLVED_CODE,
  WORKTREE_HOST_UNRESOLVED_ERROR
} from './editor-panel-content-types'

describe('EditorFileLoadErrorView', () => {
  afterEach(cleanup)

  it('offers Retry as its only action', () => {
    // Why: closing must stay with the tab strip, whose path carries the pin, shared-
    // reference, and unsaved-changes checks; a second close control here would not.
    const onRetry = vi.fn()

    render(<EditorFileLoadErrorView message="selector_not_found" onRetry={onRetry} />)

    screen.getByText('selector_not_found')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('localizes the host-unresolved state by its sentinel code, not by the stored text', () => {
    // Why: the stored `loadError` is an English fallback; the code is what selects the
    // localized copy, so a translated catalog cannot desynchronize from the comparison.
    render(
      <EditorFileLoadErrorView
        message="stored fallback text"
        code={WORKTREE_HOST_UNRESOLVED_CODE}
        onRetry={vi.fn()}
      />
    )

    screen.getByText(WORKTREE_HOST_UNRESOLVED_ERROR)
    expect(screen.queryByText('stored fallback text')).toBeNull()
  })

  it('localizes file_too_large error message when rendered without code', () => {
    render(<EditorFileLoadErrorView message={FILE_TOO_LARGE_CODE} onRetry={vi.fn()} />)

    screen.getByText(FILE_TOO_LARGE_ERROR)
    expect(screen.queryByText(FILE_TOO_LARGE_CODE)).toBeNull()
  })

  it('localizes file_too_large error by code even if fallback message is raw text', () => {
    render(
      <EditorFileLoadErrorView
        message="raw error message"
        code={FILE_TOO_LARGE_CODE}
        onRetry={vi.fn()}
      />
    )

    screen.getByText(FILE_TOO_LARGE_ERROR)
    expect(screen.queryByText('raw error message')).toBeNull()
  })
})
