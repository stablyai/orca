// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { folderWorkspaceToWorktree } from '../../../../shared/folder-workspace-worktree'
import { makeRepo } from '../worktree-jump-palette-test-fixtures'
import { useWorkspaceKanbanBoardProjection } from './use-workspace-kanban-board-projection'

const initialState = useAppStore.getInitialState()

function folderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: 'group-1',
    name: 'API-123 : Fix checkout',
    folderPath: '/tickets/API-123',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1,
    workspaceStatus: 'in-review',
    ...overrides
  }
}

const LOCAL_FOLDER = folderWorkspace({ id: 'fw-local', name: 'Local ticket' })
const SSH_FOLDER = folderWorkspace({
  id: 'fw-ssh',
  name: 'Remote ticket',
  connectionId: 'build-box'
})

/** Board membership only — lane ordering is covered by the grouping suites. */
function renderBoardWorktreeIds(): string[] {
  const repo = makeRepo()
  const { result } = renderHook(() =>
    useWorkspaceKanbanBoardProjection({
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      allWorktrees: [LOCAL_FOLDER, SSH_FOLDER].map(folderWorkspaceToWorktree),
      open: false,
      repoMap: new Map([[repo.id, repo]]),
      sortBy: 'manual',
      workspaceStatuses: useAppStore.getState().workspaceStatuses
    })
  )
  return result.current.boardWorktrees.map((worktree) => worktree.id).sort()
}

describe('useWorkspaceKanbanBoardProjection folder workspace host filter', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('drops a folder workspace whose execution host is hidden', () => {
    useAppStore.setState({ visibleWorkspaceHostIds: ['local'], workspaceHostScope: 'local' })

    expect(renderBoardWorktreeIds()).toEqual(['folder:fw-local'])
  })

  it('keeps a folder workspace whose execution host is visible', () => {
    useAppStore.setState({
      visibleWorkspaceHostIds: ['ssh:build-box'],
      workspaceHostScope: 'ssh:build-box'
    })

    expect(renderBoardWorktreeIds()).toEqual(['folder:fw-ssh'])
  })

  it('falls back to the single-host scope when no visible host ids are stored', () => {
    useAppStore.setState({ visibleWorkspaceHostIds: null, workspaceHostScope: 'ssh:build-box' })

    expect(renderBoardWorktreeIds()).toEqual(['folder:fw-ssh'])
  })

  it('keeps every folder workspace under the all-hosts scope', () => {
    useAppStore.setState({ visibleWorkspaceHostIds: null, workspaceHostScope: 'all' })

    expect(renderBoardWorktreeIds()).toEqual(['folder:fw-local', 'folder:fw-ssh'])
  })
})
