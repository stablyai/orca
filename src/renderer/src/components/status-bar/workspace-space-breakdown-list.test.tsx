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

  it('renders one row per counted top-level item, including the omitted aggregate', () => {
    const { container } = render(
      <WorkspaceSpaceBreakdownList
        isScanning={false}
        worktree={worktree({
          topLevelItems: [item('node_modules', 400), item('src', 100)],
          omittedTopLevelItemCount: 7,
          omittedTopLevelSizeBytes: 900
        })}
      />
    )

    const names = renderedRowNames(container)
    expect(names).toEqual(['node_modules', 'src', 'Other top-level items (7)'])
    // The header count labels this list: the 7 omitted items are one aggregate row.
    expect(container.textContent).toContain('9 top-level items')
    expect(names.length - 1 + 7).toBe(9)
  })

  it('scales the size bars against the omitted aggregate when it is the largest item', () => {
    const { container } = render(
      <WorkspaceSpaceBreakdownList
        isScanning={false}
        worktree={worktree({
          topLevelItems: [item('src', 250)],
          omittedTopLevelItemCount: 3,
          omittedTopLevelSizeBytes: 1000
        })}
      />
    )

    const widths = Array.from(container.querySelectorAll<HTMLElement>('div[style]')).map(
      (node) => node.style.width
    )
    expect(widths).toEqual(['25%', '100%'])
  })

  it('omits the aggregate row when nothing was omitted', () => {
    const { container } = render(
      <WorkspaceSpaceBreakdownList
        isScanning={false}
        worktree={worktree({ topLevelItems: [item('src', 250)] })}
      />
    )

    expect(renderedRowNames(container)).toEqual(['src'])
    expect(container.textContent).toContain('1 top-level items')
  })

  it('explains how to inspect folders when a saved scan omits every item', () => {
    const { container } = render(
      <WorkspaceSpaceBreakdownList
        isScanning={false}
        worktree={worktree({ omittedTopLevelItemCount: 4, omittedTopLevelSizeBytes: 80 })}
      />
    )

    expect(container.textContent).not.toContain('No files found.')
    expect(renderedRowNames(container)).toEqual([])
    expect(container.textContent).toContain('Refresh to inspect this workspace.')
  })
})
