// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { getWorkspaceCleanupGroup } from '../../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import {
  FACET_NOW,
  makeFacetCandidate as makeCandidate
} from '../query/workspace-cleanup-facet.test.fixture'
import { CandidateRow } from '../candidate-list/workspace-cleanup-candidate-row'
import WorkspaceCleanupDialog from '../WorkspaceCleanupDialog'
import { focusWorkspaceCleanupConfirmOpener } from '../dialog/workspace-cleanup-confirm-opener-focus'
import { getWorkspaceCleanupGroupTabId } from '../dialog/workspace-cleanup-group-cards'
import { WorkspaceCleanupRunStep } from './run/workspace-cleanup-run-step'
import {
  useWorkspaceCleanupRunStore,
  type WorkspaceCleanupRun
} from './run/workspace-cleanup-run-store'

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  useWorkspaceCleanupRunStore.setState({ run: null })
  vi.stubGlobal('api', { workspaceCleanup: {} })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const noop = (): void => {}
const candidate = makeCandidate({
  worktreeId: 'repo-1::/repo/flaky',
  path: '/repo/flaky',
  displayName: 'flaky-login',
  executionHostId: 'ssh:workbench-lab'
})
const identity = getWorkspaceCleanupCandidateIdentity(candidate)
const failure = {
  worktreeId: candidate.worktreeId,
  executionHostId: candidate.executionHostId,
  displayName: candidate.displayName,
  message: 'Git status could not be verified.',
  canDeleteAnyway: true
}
const run: WorkspaceCleanupRun = {
  id: 1,
  rows: [{ candidate, identity, status: 'failed', failure, attempt: 1 }]
}
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()))

function renderRun(onDeleteAnyway: (row: typeof candidate) => void) {
  const renderStep = (currentRun: WorkspaceCleanupRun): React.JSX.Element => (
    <TooltipProvider>
      <Dialog open>
        <DialogContent showCloseButton={false}>
          <WorkspaceCleanupRunStep
            run={currentRun}
            now={0}
            onDeleteAnyway={onDeleteAnyway}
            onClose={noop}
            onDone={noop}
          />
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  )
  const { rerender } = render(renderStep(run))
  return (currentRun: WorkspaceCleanupRun): void => rerender(renderStep(currentRun))
}

function renderCleanupDialog() {
  const row = { ...candidate, executionHostId: 'local' as const }
  const scan = { candidates: [row], scannedAt: FACET_NOW, errors: [] }
  const removeWorkspaceCleanupCandidates = vi.fn(async () => ({
    removedIds: [],
    removedIdentities: [],
    failures: [{ ...failure, executionHostId: row.executionHostId }]
  }))
  useAppStore.setState({
    activeModal: 'workspace-cleanup',
    workspaceCleanupScan: scan,
    hydrateWorkspaceCleanupFromCache: async () => false,
    hydrateWorkspaceSpaceFromCache: async () => false,
    scanWorkspaceCleanup: async () => scan,
    removeWorkspaceCleanupCandidates
  })
  render(
    <TooltipProvider>
      <WorkspaceCleanupDialog />
    </TooltipProvider>
  )
  return { row, scan, removeWorkspaceCleanupCandidates }
}

function expectConfirmationBeforeDelete(onDeleteAnyway: ReturnType<typeof vi.fn>): void {
  fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }))
  // Opening the action deletes nothing; it asks first and names the workspace.
  expect(onDeleteAnyway).not.toHaveBeenCalled()
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('flaky-login')
  expect(dialog.textContent).toContain('workbench-lab')
  fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
  expect(onDeleteAnyway).toHaveBeenCalledTimes(1)
  expect(onDeleteAnyway).toHaveBeenCalledWith(candidate)
}

describe('Delete anyway confirmation', () => {
  it('asks before a Browse row deletes anyway', () => {
    const onDeleteAnyway = vi.fn()
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
          failure={failure}
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
    renderRun(onDeleteAnyway)
    expectConfirmationBeforeDelete(onDeleteAnyway)
  })

  it.each(['disabled', 'removed'])(
    'focuses Done when Escape dismisses a retry with its opener %s',
    async (opener) => {
      const onDeleteAnyway = vi.fn()
      const updateRun = renderRun(onDeleteAnyway)
      fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }))
      const cancel = screen.getByRole('button', { name: 'Cancel' })
      act(() => {
        if (opener === 'disabled') {
          useAppStore
            .getState()
            .markWorktreesQueuedForDeletion([
              { id: candidate.worktreeId, hostId: candidate.executionHostId! }
            ])
        }
        fireEvent.keyDown(cancel, { key: 'Escape' })
        if (opener === 'removed') {
          updateRun({ ...run, rows: [] })
        }
      })
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Done' }))
      )
      expect(screen.queryByRole('dialog', { name: 'Delete anyway' })).toBeNull()
      expect(onDeleteAnyway).not.toHaveBeenCalled()
    }
  )
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
    const { scan, removeWorkspaceCleanupCandidates } = renderCleanupDialog()
    fireEvent.click(screen.getByRole('button', { name: /^Remove flaky-login/ }))
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toHaveProperty(
      'disabled',
      false
    )
    act(() => useAppStore.setState({ workspaceCleanupScan: { ...scan, candidates: [] } }))
    expect(screen.getByRole('button', { name: 'Delete permanently' })).toHaveProperty(
      'disabled',
      true
    )
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('tab', { selected: true }))
    )
    expect(removeWorkspaceCleanupCandidates).not.toHaveBeenCalled()
  })

  it('returns from Stop agents to the Run retry without submitting it', async () => {
    const { row, removeWorkspaceCleanupCandidates } = renderCleanupDialog()
    fireEvent.click(screen.getByRole('button', { name: /^Remove flaky-login/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
    const retry = await screen.findByRole('button', { name: 'Delete anyway' })
    act(() => {
      const tab = {
        id: 'fixture-tab',
        worktreeId: row.worktreeId,
        ptyId: 'fixture-pty',
        title: 'Fixture task',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: FACET_NOW
      }
      useAppStore.setState({ tabsByWorktree: { [row.worktreeId]: [tab] } })
      useAppStore
        .getState()
        .setAgentStatus(
          makePaneKey(tab.id, '11111111-1111-4111-8111-111111111111'),
          { state: 'working', agentType: 'codex', prompt: 'Organize sample files' },
          'Fixture task',
          undefined,
          { worktreeId: row.worktreeId, connectionId: null }
        )
    })
    fireEvent.click(retry)
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }))
    expect(screen.getByText("Deleting will stop the agent's current work.")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Delete anyway' }))
    )
    expect(removeWorkspaceCleanupCandidates).toHaveBeenCalledTimes(1)
  })
})
