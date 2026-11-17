// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { DeleteWorktreeChangesSummary } from './DeleteWorktreeChangesSummary'
import { DeleteWorktreeError } from './DeleteWorktreeError'

afterEach(cleanup)

it('keeps the dirty workspace warning to one line and puts the ignored-file uncertainty in details', () => {
  const worktree = makeWorktree({ id: 'wt-1', repoId: 'repo-1' })
  const { container } = render(
    <DeleteWorktreeChangesSummary
      worktree={worktree}
      dirtyChanges={{
        counts: new Map([['wt-1', 3]]),
        checkStates: new Map([['wt-1', 'complete']]),
        previews: new Map([
          [
            'wt-1',
            {
              files: [{ path: 'src/login.ts', status: 'modified', hasUnresolvedConflict: false }],
              remainingPathCount: 0
            }
          ]
        ])
      }}
      unsavedFiles={[]}
      atRiskLocalFilesByIdentity={
        new Map([
          [
            getWorktreeHostIdentity(worktree),
            { status: 'complete', files: { count: 0, samplePaths: [], complete: false } }
          ]
        ])
      }
    />
  )
  expect(container.querySelectorAll('[data-slot="dialog-warning"]')).toHaveLength(1)
  expect(screen.getByText('Ignored files could not be fully checked')).not.toBeVisible()
})

it('explains force deletion without exposing raw git output until details are opened', () => {
  render(<DeleteWorktreeError canForceDelete message="fatal: directory has changes; use --force" />)
  expect(screen.getByRole('alert')).not.toHaveTextContent(/fatal:|--force/)
  expect(screen.getByText('fatal: directory has changes; use --force')).not.toBeVisible()
})
