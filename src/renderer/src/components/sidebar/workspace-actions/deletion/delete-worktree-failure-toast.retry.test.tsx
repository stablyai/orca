// @vitest-environment happy-dom
// REG-12: an Orca Cloud delete that failed before any sandbox delete was sent offers Try again.
import type React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_DELETE_NOT_SENT_UNCHECKED } from '../../../../../../shared/recipe-host-removal'

const shown = vi.hoisted((): { description: React.ReactNode; duration: number } => ({
  description: null,
  duration: 0
}))
vi.mock('sonner', () => {
  const show = (_title: string, options: { description: React.ReactNode; duration: number }) => {
    shown.description = options.description
    shown.duration = options.duration
  }
  return {
    toast: Object.assign(vi.fn(show), { error: vi.fn(show), info: vi.fn(show), dismiss: vi.fn() })
  }
})

import { showDeleteWorktreeFailureToast } from './delete-worktree-failure-toast'

afterEach(cleanup)

function showFor(error: string, onRetry = vi.fn()) {
  showDeleteWorktreeFailureToast({
    error,
    canForceDelete: false,
    forceDeleteReason: null,
    onViewChanges: vi.fn(),
    onForceDelete: vi.fn(),
    onDeleteAnyway: vi.fn(),
    onRetry,
    worktreeId: 'wt-cloud',
    worktreeName: 'ik-actions'
  })
  render(<>{shown.description}</>)
  return onRetry
}

describe('delete failure toast: Try again', () => {
  it('offers Try again when no sandbox delete was sent, and it re-runs the delete', () => {
    const onRetry = showFor(CLOUD_DELETE_NOT_SENT_UNCHECKED)
    expect(screen.getByText(CLOUD_DELETE_NOT_SENT_UNCHECKED)).toBeTruthy()
    // It stays until the user acts: deleting must not silently time out.
    expect(shown.duration).toBe(Infinity)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it('does not offer it for other failures (a retry could repeat a partial destroy)', () => {
    showFor('Environment destroy failed. The environment may still be running.')
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })
})
