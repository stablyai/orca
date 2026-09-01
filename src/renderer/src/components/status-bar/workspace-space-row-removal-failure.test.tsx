// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceRow } from './WorkspaceSpaceManagerPanel'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'

// Electron wraps every invoke rejection as `Error invoking remote method '<channel>': ${err}`,
// and this row reads the same deleteState the sidebar toast does — the plumbing reaches Space too.
const ENVELOPED_REASON =
  "Error invoking remote method 'worktrees:remove': Error: Failed to delete worktree at /w/feature. ?? scratch.txt"
const ENVELOPE_ONLY = "Error invoking remote method 'worktrees:remove': Error"
const UNREADABLE_COPY =
  'Orca could not delete this workspace, and the failure did not include a readable reason. Retry, and send app diagnostics to support if it keeps failing.'

const worktree: WorkspaceSpaceWorktree = {
  worktreeId: 'repo1::/w/feature',
  repoId: 'repo1',
  repoDisplayName: 'repo1',
  repoPath: '/w',
  displayName: 'feature',
  path: '/w/feature',
  branch: 'feature',
  isMainWorktree: false,
  isRemote: false,
  isSparse: false,
  canDelete: true,
  lastActivityAt: 0,
  status: 'ok',
  error: null,
  scannedAt: 0,
  sizeBytes: 1024,
  reclaimableBytes: 0,
  skippedEntryCount: 0,
  topLevelItems: [],
  omittedTopLevelItemCount: 0,
  omittedTopLevelSizeBytes: 0
}

const decisionDetails = {
  isActive: false,
  canOpenWorkspace: true,
  terminalTabCount: 0,
  liveTerminalCount: 0,
  activeAgentCount: 0,
  completedAgentCount: 0,
  openEditorFileCount: 0,
  dirtyEditorBufferCount: 0,
  browserTabCount: 0,
  changedFileCount: 0,
  branchStatus: null,
  reviewLabel: null,
  issueLabel: null,
  linearIssueLabel: null
}

function renderRow(error: string): void {
  render(
    <WorkspaceRow
      worktree={worktree}
      maxSize={4096}
      selected={false}
      inspected={false}
      decisionDetails={decisionDetails}
      deleteState={{
        isDeleting: false,
        error,
        canForceDelete: false,
        forceDeleteReason: null
      }}
      onToggleSelected={() => {}}
      onInspect={() => {}}
      onOpenWorkspace={() => {}}
      onDelete={() => {}}
      onForceDelete={() => {}}
    />
  )
}

afterEach(cleanup)

describe('Space workspace row removal failure', () => {
  it('shows only the reason', () => {
    renderRow(ENVELOPED_REASON)
    expect(screen.queryByText(/invoking remote method/)).toBeNull()
    expect(
      screen.getByText('Failed to delete worktree at /w/feature. ?? scratch.txt')
    ).toBeInTheDocument()
  })

  // Why: the row also puts this string in a `title` attribute, which the envelope leaked into
  // even when the visible text was clipped.
  it('shows human copy, in the tooltip too, when nothing readable arrived', () => {
    renderRow(ENVELOPE_ONLY)
    expect(screen.queryByText(/invoking remote method/)).toBeNull()
    expect(screen.getByTitle(UNREADABLE_COPY)).toBeInTheDocument()
  })
})
