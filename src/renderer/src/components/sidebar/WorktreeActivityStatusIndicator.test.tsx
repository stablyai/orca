import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeStatus } from '@/lib/worktree-status'
import { WorktreeActivityStatusIndicator } from './WorktreeActivityStatusIndicator'

const mocks = vi.hoisted(() => ({
  status: 'inactive' as WorktreeStatus
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: vi.fn(() => mocks.status)
}))

function renderMarkup(status: WorktreeStatus): string {
  mocks.status = status
  return renderToStaticMarkup(
    React.createElement(WorktreeActivityStatusIndicator, { worktreeId: 'wt-child' })
  )
}

describe('WorktreeActivityStatusIndicator', () => {
  beforeEach(() => {
    mocks.status = 'inactive'
  })

  it('forwards the sr-only label but draws no dot for slept worktrees', () => {
    const markup = renderMarkup('inactive')

    expect(markup).toContain('Inactive')
    expect(markup).not.toContain('rounded-full')
  })

  it('forwards a visible status dot when the worktree needs attention', () => {
    const markup = renderMarkup('permission')

    expect(markup).toContain('Needs permission')
    expect(markup).toContain('bg-status-warning')
  })
})
