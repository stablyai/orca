// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSpaceWorktree } from '../../../../shared/workspace-space-types'
import type { WorkspaceDecisionDetails } from './workspace-space-decision-details'
import { WorkspaceSpaceWorktreeRow } from './workspace-space-worktree-row'

const revealInFileManager = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reveal-in-file-manager', () => ({
  getRevealInFileManagerLabel: () => 'Reveal in Finder',
  revealInFileManager
}))
vi.mock('../ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('./workspace-space-decision-hover-card', () => ({
  WorkspaceDecisionHoverCard: () => null
}))

const worktree: WorkspaceSpaceWorktree = {
  worktreeId: 'repo::/workspace',
  repoId: 'repo',
  executionHostId: 'local',
  repoDisplayName: 'repo',
  repoPath: '/repo',
  displayName: 'workspace',
  path: '/workspace',
  branch: 'main',
  isMainWorktree: true,
  isRemote: false,
  isSparse: false,
  canDelete: false,
  lastActivityAt: 0,
  status: 'ok',
  error: null,
  scannedAt: 0,
  sizeBytes: 4096,
  reclaimableBytes: 0,
  skippedEntryCount: 0,
  topLevelItems: [],
  omittedTopLevelItemCount: 0,
  omittedTopLevelSizeBytes: 0
}

const decisionDetails: WorkspaceDecisionDetails = {
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

afterEach(() => {
  cleanup()
  revealInFileManager.mockReset()
})

describe('WorkspaceSpaceWorktreeRow context menu', () => {
  it('shows the existing workspace activity timestamp with its full time on hover', () => {
    const lastActivityAt = Date.now() - 2 * 60 * 60 * 1000
    render(
      <WorkspaceSpaceWorktreeRow
        worktree={{ ...worktree, lastActivityAt }}
        selected={false}
        inspected={false}
        decisionDetails={decisionDetails}
        onToggleSelected={() => {}}
        onInspect={() => {}}
        onOpenWorkspace={() => {}}
        onDelete={() => {}}
        onForceDelete={() => {}}
      />
    )

    expect(screen.getByText('2h').getAttribute('title')).toBeTruthy()
  })

  it('reveals a workspace even when deletion is unavailable', () => {
    render(
      <WorkspaceSpaceWorktreeRow
        worktree={worktree}
        selected={false}
        inspected={false}
        decisionDetails={decisionDetails}
        onToggleSelected={() => {}}
        onInspect={() => {}}
        onOpenWorkspace={() => {}}
        onDelete={() => {}}
        onForceDelete={() => {}}
      />
    )

    fireEvent.contextMenu(
      screen.getByText('workspace').closest('[data-slot="context-menu-trigger"]')!
    )
    expect(
      screen
        .getByText('Delete workspace')
        .closest('[role="menuitem"]')
        ?.getAttribute('data-disabled')
    ).toBe('')
    expect(screen.queryByRole('button', { name: 'Delete workspace' })).toBeNull()
    fireEvent.click(screen.getByText('Reveal in Finder'))
    expect(revealInFileManager).toHaveBeenCalledWith('/workspace', 'local')
  })

  it('keeps deletion beside reveal for an eligible linked worktree', () => {
    const onDelete = vi.fn()
    render(
      <WorkspaceSpaceWorktreeRow
        worktree={{ ...worktree, isMainWorktree: false, canDelete: true }}
        selected={false}
        inspected={false}
        decisionDetails={decisionDetails}
        onToggleSelected={() => {}}
        onInspect={() => {}}
        onOpenWorkspace={() => {}}
        onDelete={onDelete}
        onForceDelete={() => {}}
      />
    )

    fireEvent.contextMenu(
      screen.getByText('workspace').closest('[data-slot="context-menu-trigger"]')!
    )
    expect(screen.getByText('Reveal in Finder')).toBeTruthy()
    const menuItem = screen.getByText('Delete workspace').closest('[role="menuitem"]')
    expect(menuItem?.getAttribute('data-disabled')).toBeNull()
    fireEvent.click(screen.getByText('Delete workspace'))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it('offers a direct delete control without opening or selecting the row', () => {
    const onDelete = vi.fn()
    const onInspect = vi.fn()
    render(
      <WorkspaceSpaceWorktreeRow
        worktree={{ ...worktree, isMainWorktree: false, canDelete: true }}
        selected={false}
        inspected={false}
        decisionDetails={decisionDetails}
        onToggleSelected={() => {}}
        onInspect={onInspect}
        onOpenWorkspace={() => {}}
        onDelete={onDelete}
        onForceDelete={() => {}}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete workspace' }))
    expect(onDelete).toHaveBeenCalledTimes(1)
    expect(onInspect).not.toHaveBeenCalled()
  })
})
