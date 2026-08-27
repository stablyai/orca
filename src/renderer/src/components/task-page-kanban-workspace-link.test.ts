import { describe, expect, it } from 'vitest'
import type { WorkspaceLinkedItem } from '../../../shared/worktree/types'
import {
  findKanbanTaskWorkspaceLink,
  type KanbanFolderWorkspaceCandidate,
  type KanbanWorktreeCandidate
} from './task-page-kanban-workspace-link'

function kanbanLink(id: string): WorkspaceLinkedItem {
  return {
    provider: 'kanban',
    type: 'issue',
    number: 0,
    title: 'Task',
    url: `https://kanban.fpimi.ru/?task=${id}`,
    kanbanIdentifier: id
  }
}

const legacyGithubLink: WorkspaceLinkedItem = {
  provider: 'github',
  type: 'issue',
  number: 7,
  title: 'Issue seven',
  url: 'https://github.com/acme/widgets/issues/7'
}

function worktree(id: string, linked: WorkspaceLinkedItem | null): KanbanWorktreeCandidate {
  return { id, isArchived: false, linkedWorkItem: linked }
}

function archivedWorktree(id: string, linked: WorkspaceLinkedItem | null): KanbanWorktreeCandidate {
  return { id, isArchived: true, linkedWorkItem: linked }
}

function folder(id: string, linked: WorkspaceLinkedItem | null): KanbanFolderWorkspaceCandidate {
  return { id, isArchived: false, linkedTask: linked }
}

function archivedFolder(
  id: string,
  linked: WorkspaceLinkedItem | null
): KanbanFolderWorkspaceCandidate {
  return { id, isArchived: true, linkedTask: linked }
}

describe('findKanbanTaskWorkspaceLink', () => {
  it('finds the matching worktree by provider and kanbanIdentifier', () => {
    const result = findKanbanTaskWorkspaceLink({
      worktrees: [worktree('wt-1', kanbanLink('t1'))],
      folderWorkspaces: [],
      taskId: 't1'
    })
    expect(result).toEqual({
      kind: 'worktree',
      workspaceId: 'wt-1',
      worktree: { id: 'wt-1', isArchived: false, linkedWorkItem: kanbanLink('t1') }
    })
  })

  it('finds the matching folder workspace with a folder: workspace key', () => {
    const result = findKanbanTaskWorkspaceLink({
      worktrees: [],
      folderWorkspaces: [folder('fw-1', kanbanLink('t1'))],
      taskId: 't1'
    })
    expect(result?.kind).toBe('folder')
    if (result?.kind === 'folder') {
      expect(result.workspaceId).toBe('folder:fw-1')
      expect(result.folderWorkspace).toEqual({ id: 'fw-1', isArchived: false, linkedTask: kanbanLink('t1') })
    }
  })

  it('never matches legacy unrelated work items', () => {
    const result = findKanbanTaskWorkspaceLink({
      worktrees: [worktree('wt-legacy', legacyGithubLink)],
      folderWorkspaces: [],
      taskId: 't1'
    })
    expect(result).toBeNull()
  })

  it('never matches a kanban item with a different identifier', () => {
    const result = findKanbanTaskWorkspaceLink({
      worktrees: [worktree('wt-other', kanbanLink('t9'))],
      folderWorkspaces: [],
      taskId: 't1'
    })
    expect(result).toBeNull()
  })

  it('skips archived worktrees and folder workspaces', () => {
    const result = findKanbanTaskWorkspaceLink({
      worktrees: [archivedWorktree('wt-archived', kanbanLink('t1'))],
      folderWorkspaces: [archivedFolder('fw-archived', kanbanLink('t1'))],
      taskId: 't1'
    })
    expect(result).toBeNull()
  })

  it('prefers a worktree over a folder workspace when both match', () => {
    const result = findKanbanTaskWorkspaceLink({
      worktrees: [worktree('wt-1', kanbanLink('t1'))],
      folderWorkspaces: [folder('fw-1', kanbanLink('t1'))],
      taskId: 't1'
    })
    expect(result?.kind).toBe('worktree')
    if (result?.kind === 'worktree') {
      expect(result.workspaceId).toBe('wt-1')
    }
  })

  it('returns null when nothing matches', () => {
    const result = findKanbanTaskWorkspaceLink({
      worktrees: [],
      folderWorkspaces: [],
      taskId: 't1'
    })
    expect(result).toBeNull()
  })
})