// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'
import {
  WORKTREE_HOST_UNRESOLVED_CODE,
  WORKTREE_HOST_UNRESOLVED_ERROR
} from './editor-panel-content-types'

describe('EditorFileLoadErrorView', () => {
  afterEach(cleanup)

  it('offers Retry as its only action', () => {
    // Only the tab-strip close path enforces pins, shared references and unsaved-change checks.
    const onRetry = vi.fn()

    render(<EditorFileLoadErrorView message="selector_not_found" onRetry={onRetry} />)

    screen.getByText('selector_not_found')
    expect(screen.getAllByRole('button')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('drops the IPC wrapper from a stored host error', () => {
    render(
      <EditorFileLoadErrorView
        message="Error invoking remote method 'runtimeEnvironments:call': Error: WSL hosts are turned off in Settings → Experimental."
        onRetry={vi.fn()}
      />
    )

    screen.getByText('WSL hosts are turned off in Settings → Experimental.')
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull()
  })

  it('localizes the host-unresolved state by its sentinel code, not by the stored text', () => {
    // Select localized text by machine code so stored English cannot affect state classification.
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
})
