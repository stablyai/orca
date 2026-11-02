// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceSpaceBreakdownList } from './workspace-space-breakdown-list'
import type {
  WorkspaceSpaceItem,
  WorkspaceSpaceWorktree
} from '../../../../shared/workspace-space-types'

const revealInFileManager = vi.hoisted(() => vi.fn())
vi.mock('@/lib/reveal-in-file-manager', () => ({
  getRevealInFileManagerLabel: () => 'Reveal in Finder',
  revealInFileManager
}))

function item(name: string, sizeBytes: number): WorkspaceSpaceItem {
  return { name, path: `/workspace/${name}`, kind: 'directory', sizeBytes }
}

function worktree(overrides: Partial<WorkspaceSpaceWorktree>): WorkspaceSpaceWorktree {
  return {
    worktreeId: 'wt',
    repoId: 'repo',
    repoDisplayName: 'repo',
    repoPath: '/repo',
    displayName: 'workspace',
    path: '/workspace',
    branch: 'refs/heads/main',
    isMainWorktree: false,
    isRemote: false,
    isSparse: false,
    canDelete: true,
    lastActivityAt: 0,
    status: 'ok',
    error: null,
    scannedAt: 0,
    sizeBytes: 0,
    reclaimableBytes: 0,
    skippedEntryCount: 0,
    topLevelItems: [],
    omittedTopLevelItemCount: 0,
    omittedTopLevelSizeBytes: 0,
    ...overrides
  }
}

function renderedRowNames(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('span.font-medium')).map(
    (node) => node.textContent ?? ''
  )
}

afterEach(() => {
  cleanup()
  revealInFileManager.mockReset()
})

describe('WorkspaceSpaceBreakdownList', () => {
  it('reveals the selected top-level folder from its context menu', () => {
    render(
      <WorkspaceSpaceBreakdownList
        isScanning={false}
        worktree={worktree({
          executionHostId: 'local',
          topLevelItems: [item('src', 250)]
        })}
      />
    )

    fireEvent.contextMenu(screen.getByText('src'))
    fireEvent.click(screen.getByText('Reveal in Finder'))
    expect(revealInFileManager).toHaveBeenCalledWith('/workspace/src', 'local')
  })

  it('keeps compacted folder details available in the overflow popover', () => {
    const { container } = render(
      <WorkspaceSpaceBreakdownList
        isScanning={false}
        worktree={worktree({
          topLevelItems: [
            item('first', 500),
            item('second', 400),
            item('third', 300),
            item('fourth', 200),
            item('fifth', 100)
          ]
        })}
      />
    )

    expect(renderedRowNames(container)).toEqual(['first', 'second', 'third', 'fourth'])
    fireEvent.click(screen.getByText('Show more folder details'))
    expect(screen.getAllByText('fifth')).toHaveLength(1)
  })
})
