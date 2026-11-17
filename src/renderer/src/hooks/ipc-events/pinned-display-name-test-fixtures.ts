import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
export const TITLE = 'Triage assigned issues prs'

export function folderWorkspace(id: string): FolderWorkspace {
  return {
    id,
    projectGroupId: 'group-1',
    name: 'Folder',
    folderPath: '/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}
export const CHAT_TABS = 100

/** Counts full walks of an index, which is how a copy reads it. */
export function countIterations(target: Map<string, Worktree> | Worktree[]): () => number {
  let walks = 0
  const iterate = target[Symbol.iterator].bind(target)
  Object.defineProperty(target, Symbol.iterator, {
    configurable: true,
    value: () => {
      walks++
      return iterate()
    }
  })
  return () => walks
}

export function repo(id: string): Repo {
  return { id, path: '/work', displayName: id, badgeColor: '#000000', addedAt: 0 }
}

export function chatTab(worktreeId: string, index: number): Tab {
  return {
    id: `chat-${index}`,
    entityId: `chat-${index}`,
    groupId: `group-${index}`,
    worktreeId,
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    label: `Chat ${index}`,
    customLabel: null,
    color: null,
    sortOrder: index,
    createdAt: 0
  }
}

export function row(
  size: number,
  index: number,
  isArchived: boolean,
  onRead: () => void
): Worktree {
  const worktree: Worktree = {
    id: `repo-${size}::/work/w${index}`,
    repoId: `repo-${size}`,
    path: `/work/w${index}`,
    head: 'aaa',
    branch: `refs/heads/w${index}`,
    isBare: false,
    isMainWorktree: false,
    displayName: index === 0 ? 'batfish-2' : `w${index}`,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    instanceId: `instance-${size}-${index}`
  }
  Object.defineProperty(worktree, 'isArchived', {
    enumerable: true,
    get: () => {
      onRead()
      return isArchived
    }
  })
  return worktree
}
