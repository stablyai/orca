// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getWorkspaceCleanupGroup } from '../../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { makeFacetCandidate as makeCandidate } from '../query/workspace-cleanup-facet.test.fixture'
import { CandidateRow } from '../candidate-list/workspace-cleanup-candidate-row'
import { WorkspaceCleanupRetryButton } from './workspace-cleanup-retry-button'
import { focusWorkspaceCleanupConfirmOpener } from '../dialog/workspace-cleanup-confirm-opener-focus'
import { getWorkspaceCleanupGroupTabId } from '../dialog/workspace-cleanup-group-cards'

afterEach(cleanup)

const candidate = makeCandidate({ worktreeId: 'repo-1::/repo/flaky', displayName: 'flaky-login' })
const identity = getWorkspaceCleanupCandidateIdentity(candidate)
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

function expectConfirmationBeforeDelete(onDeleteAnyway: ReturnType<typeof vi.fn>): void {
  fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }))
  // Opening the action deletes nothing; it asks first and names the workspace.
  expect(onDeleteAnyway).not.toHaveBeenCalled()
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('flaky-login')
  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
  expect(onDeleteAnyway).toHaveBeenCalledTimes(1)
  expect(onDeleteAnyway).toHaveBeenCalledWith(candidate)
}

describe('Delete anyway confirmation', () => {
  it('asks before a Browse row deletes anyway', () => {
    const onDeleteAnyway = vi.fn()
    const noop = (): void => {}
    render(
      <TooltipProvider>
        <CandidateRow
          identity={identity}
          candidate={candidate}
          reviewInfo={{ hasReview: false, label: null, state: null, provider: null, title: null }}
          repo={null}
          group={getWorkspaceCleanupGroup(candidate)}
          expanded={false}
          last
          lastActivityLabel="9d ago"
          sizeLabel={null}
          workspaceStatusLabel={null}
          removing={false}
          failure={{
            worktreeId: candidate.worktreeId,
            displayName: candidate.displayName,
            message: 'Git status could not be verified.',
            canDeleteAnyway: true
          }}
          selected={false}
          onIgnore={noop}
          onRestore={noop}
          onRemove={noop}
          onForgetLocally={noop}
          onDeleteAnyway={onDeleteAnyway}
          onToggleExpanded={noop}
          onToggleSelected={noop}
          onView={noop}
        />
      </TooltipProvider>
    )
    expectConfirmationBeforeDelete(onDeleteAnyway)
  })

  it('asks before the run summary deletes anyway', () => {
    const onDeleteAnyway = vi.fn()
    render(<WorkspaceCleanupRetryButton candidate={candidate} onConfirm={onDeleteAnyway} />)
    expectConfirmationBeforeDelete(onDeleteAnyway)
  })
})

describe('Back from confirmation', () => {
  function renderList(): void {
    render(
      <div>
        <button type="button" id={getWorkspaceCleanupGroupTabId('nothing-local')}>
          Safe tab
        </button>
        <button type="button" data-workspace-cleanup-remove="other">
          Remove other
        </button>
        <button type="button" data-workspace-cleanup-remove={identity}>
          Remove flaky
        </button>
        <button type="button" data-workspace-cleanup-bulk-delete>
          Delete 2 workspaces
        </button>
      </div>
    )
  }

  it("returns focus to the row's Remove that opened it", async () => {
    renderList()
    focusWorkspaceCleanupConfirmOpener({ kind: 'row', identity }, 'nothing-local')
    await nextFrame()
    expect(document.activeElement?.textContent).toBe('Remove flaky')
  })

  it('returns focus to the bulk Delete that opened it', async () => {
    renderList()
    focusWorkspaceCleanupConfirmOpener({ kind: 'bulk' }, 'nothing-local')
    await nextFrame()
    expect(document.activeElement?.textContent).toBe('Delete 2 workspaces')
  })

  it('falls back to the group tab when the opener is no longer rendered', async () => {
    renderList()
    focusWorkspaceCleanupConfirmOpener({ kind: 'row', identity: 'gone' }, 'nothing-local')
    await nextFrame()
    expect(document.activeElement?.textContent).toBe('Safe tab')
  })
})
