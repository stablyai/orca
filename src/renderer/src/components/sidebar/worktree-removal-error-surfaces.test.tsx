// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DeleteWorktreeWarningPanels } from './DeleteWorktreeWarningPanels'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeDeleteState } from '../../store/slices/worktree-delete-state-types'

// The exact shape Electron produces when a `worktrees:remove` handler rejects: the renderer
// wraps the main side's `error.toString()` (renderer/api/ipc-renderer.ts). The second form is
// what a message-less handler failure looks like — envelope, nothing behind it.
const ENVELOPED_REASON =
  "Error invoking remote method 'worktrees:remove': Error: Failed to delete worktree at /w/feature. ?? scratch.txt"
const ENVELOPE_ONLY = "Error invoking remote method 'worktrees:remove': Error"

const UNREADABLE_COPY =
  'Orca could not delete this workspace, and the failure did not include a readable reason. Retry, and send app diagnostics to support if it keeps failing.'

function deleteState(error: string): WorktreeDeleteState {
  return { isDeleting: false, error, canForceDelete: false, forceDeleteReason: null }
}

function makeWorktree(): Worktree {
  return {
    id: 'repo1::/w/feature',
    repoId: 'repo1',
    path: '/w/feature',
    head: 'abc123',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature'
  } as Worktree
}

afterEach(cleanup)

// Why: all three surfaces read the same `deleteStateByWorktreeId[...].error` the toast reads,
// so a fix confined to the toast would still show plumbing in the dialog and the space manager.
describe('workspace-removal failure surfaces', () => {
  it('shows only the reason in the delete dialog warning panel', () => {
    render(
      <DeleteWorktreeWarningPanels
        isMainWorktree={false}
        mainWorktreeBlocker=""
        deleteError={ENVELOPED_REASON}
      />
    )
    expect(screen.queryByText(/invoking remote method/)).toBeNull()
    expect(
      screen.getByText('Failed to delete worktree at /w/feature. ?? scratch.txt')
    ).toBeInTheDocument()
  })

  it('shows human copy in the delete dialog warning panel when nothing readable arrived', () => {
    render(
      <DeleteWorktreeWarningPanels
        isMainWorktree={false}
        mainWorktreeBlocker=""
        deleteError={ENVELOPE_ONLY}
      />
    )
    expect(screen.queryByText(/invoking remote method/)).toBeNull()
    expect(screen.getByText(UNREADABLE_COPY)).toBeInTheDocument()
  })

  it('shows only the reason on a delete-target row', () => {
    const worktree = makeWorktree()
    render(
      <DeleteWorktreeTargetPreview
        isBatchDelete
        worktree={null}
        worktrees={[worktree]}
        collisionWorktrees={[worktree]}
        hostLabelById={new Map()}
        deleteStateByWorktreeId={{ [worktree.id]: deleteState(ENVELOPE_ONLY) }}
        dirtyChangeCountsByWorktreeId={new Map()}
      />
    )
    expect(screen.queryByText(/invoking remote method/)).toBeNull()
    expect(screen.getByText(UNREADABLE_COPY)).toBeInTheDocument()
  })
})
