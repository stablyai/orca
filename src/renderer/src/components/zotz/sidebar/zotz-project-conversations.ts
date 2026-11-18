import type { FolderWorkspace } from '../../../../../shared/folder-workspaces/folder-workspace-types'
import { isRepoHidden } from '../../../../../shared/hidden-projects'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'

export type ZotzConversationRow = {
  /** Activation key: a worktree id, or `folder:<id>` for a folder workspace. */
  id: string
  title: string
  branch: string | null
  lastActivityAt: number
}

export type ZotzProjectSection = {
  repo: Repo
  conversations: ZotzConversationRow[]
}

type TabsByWorkspace = Readonly<Record<string, readonly unknown[] | undefined>>

function branchLabel(worktree: Pick<Worktree, 'branch' | 'head'>): string | null {
  const branch = worktree.branch.replace(/^refs\/heads\//, '')
  if (branch) {
    return branch
  }
  return worktree.head ? worktree.head.slice(0, 7) : null
}

function hasOpenTabs(tabsByWorkspace: TabsByWorkspace, key: string): boolean {
  return (tabsByWorkspace[key]?.length ?? 0) > 0
}

/** Workspaces the user started: no CLI/automation creations, and the main checkout only while it has open tabs. */
export function isZotzUserConversation(
  worktree: Worktree,
  tabsByWorkspace: TabsByWorkspace
): boolean {
  if (worktree.isArchived || worktree.removing || worktree.cliProvenance) {
    return false
  }
  if (worktree.automationProvenance) {
    return false
  }
  return !worktree.isMainWorktree || hasOpenTabs(tabsByWorkspace, worktree.id)
}

function byRecentActivity(a: ZotzConversationRow, b: ZotzConversationRow): number {
  return b.lastActivityAt - a.lastActivityAt
}

export function buildZotzProjectSections(input: {
  repos: readonly Repo[]
  worktreesByRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
  tabsByWorkspace: TabsByWorkspace
}): ZotzProjectSection[] {
  const seen = new Set<string>()
  const sections: ZotzProjectSection[] = []
  for (const repo of input.repos) {
    if (isRepoHidden(repo) || seen.has(repo.id)) {
      continue
    }
    seen.add(repo.id)
    const conversations = (input.worktreesByRepo[repo.id] ?? [])
      .filter((worktree) => isZotzUserConversation(worktree, input.tabsByWorkspace))
      .map((worktree) => {
        const branch = branchLabel(worktree)
        return {
          id: worktree.id,
          title: worktree.displayName || branch || worktree.path,
          branch,
          lastActivityAt: worktree.lastActivityAt
        }
      })
      .sort(byRecentActivity)
    sections.push({ repo, conversations })
  }
  return sections
}

/** Loose folders (like `~`) appear only while they hold a conversation. */
export function buildZotzFolderConversations(input: {
  folderWorkspaces: readonly FolderWorkspace[]
  tabsByWorkspace: TabsByWorkspace
}): ZotzConversationRow[] {
  return input.folderWorkspaces
    .filter(
      (folder) =>
        !folder.isArchived && hasOpenTabs(input.tabsByWorkspace, folderWorkspaceKey(folder.id))
    )
    .map((folder) => ({
      id: folderWorkspaceKey(folder.id),
      title: folder.name || folder.folderPath,
      branch: null,
      lastActivityAt: 0
    }))
}
