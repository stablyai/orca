import type { AgentDotState } from '../../AgentStateDot'
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
  /** Null for loose folders, which have no worktree actions. */
  worktree: Worktree | null
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

/** Workspaces the user started: no CLI/automation creations; the main checkout only while an agent works in it. */
export function isZotzUserConversation(
  worktree: Worktree,
  workspacesWithAgents: ReadonlySet<string>
): boolean {
  if (worktree.isArchived || worktree.removing || worktree.cliProvenance) {
    return false
  }
  if (worktree.automationProvenance) {
    return false
  }
  return !worktree.isMainWorktree || workspacesWithAgents.has(worktree.id)
}

function byRecentActivity(a: ZotzConversationRow, b: ZotzConversationRow): number {
  return b.lastActivityAt - a.lastActivityAt
}

export function buildZotzProjectSections(input: {
  repos: readonly Repo[]
  worktreesForRepo: Readonly<Record<string, readonly Worktree[] | undefined>>
  workspacesWithAgents: ReadonlySet<string>
}): ZotzProjectSection[] {
  const seen = new Set<string>()
  const sections: ZotzProjectSection[] = []
  for (const repo of input.repos) {
    if (isRepoHidden(repo) || seen.has(repo.id)) {
      continue
    }
    seen.add(repo.id)
    const conversations = (input.worktreesForRepo[repo.id] ?? [])
      .filter((worktree) => isZotzUserConversation(worktree, input.workspacesWithAgents))
      .map((worktree) => {
        const branch = branchLabel(worktree)
        return {
          id: worktree.id,
          title: worktree.displayName || branch || worktree.path,
          branch,
          lastActivityAt: worktree.lastActivityAt,
          worktree
        }
      })
      .sort(byRecentActivity)
    sections.push({ repo, conversations })
  }
  return sections
}

/** Loose folders (like `~`) appear only while they hold a conversation. */
export function buildZotzFolderConversations(input: {
  folders: readonly FolderWorkspace[]
  tabsByWorkspace: TabsByWorkspace
}): ZotzConversationRow[] {
  return input.folders
    .filter(
      (folder) =>
        !folder.isArchived && hasOpenTabs(input.tabsByWorkspace, folderWorkspaceKey(folder.id))
    )
    .map((folder) => ({
      id: folderWorkspaceKey(folder.id),
      title: folder.name || folder.folderPath,
      branch: null,
      lastActivityAt: 0,
      worktree: null
    }))
}

/** Most urgent first: what needs the user, then live work, then finished. */
const STATUS_URGENCY: readonly AgentDotState[] = [
  'failed',
  'blocked',
  'permission',
  'waiting',
  'interrupted',
  'unconfirmed',
  'working',
  'monitoring',
  'unverifiable',
  'done',
  'idle'
]

export type ZotzConversationStatus = { state: AgentDotState; unread: boolean }

/** One marker per conversation from all its agent threads: the most urgent state, unread if any finished unseen. */
export function summarizeZotzConversationStatus(
  threads: readonly { state: AgentDotState; unread: boolean }[]
): ZotzConversationStatus | null {
  let best: AgentDotState | null = null
  let unread = false
  for (const thread of threads) {
    if (best === null || STATUS_URGENCY.indexOf(thread.state) < STATUS_URGENCY.indexOf(best)) {
      best = thread.state
    }
    unread ||= thread.unread
  }
  return best === null ? null : { state: best, unread }
}
