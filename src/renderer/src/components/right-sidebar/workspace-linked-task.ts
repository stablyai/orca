import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { WorkspaceLinkedItem, Worktree } from '../../../../shared/worktree/types'

/** The active workspace's linked work item, in the shape the Task panel renders.
 *  Provider-neutral: every built-in task provider resolves to this identity and
 *  the panel decides per provider how much detail it can show. */
export type WorkspaceLinkedTask = {
  provider: WorkspaceLinkedItem['provider']
  type: WorkspaceLinkedItem['type']
  number: number
  /** Provider-native label: `#42`, `!42`, `ENG-31`, `PROJ-7`. */
  reference: string
  /** Stored title. Empty when only a legacy flat link field is present. */
  title: string
  /** Stored URL. Empty when only a legacy flat link field is present. */
  url: string
  linearIdentifier?: string
  jiraIdentifier?: string
  /** Repo the GitHub/GitLab number belongs to, when the link recorded one. */
  repoId?: string
  /** The account the item must be read on. Null means the selected provider. */
  sourceContext: TaskSourceContext | null
}

export function formatWorkspaceLinkedTaskReference(
  item: Pick<WorkspaceLinkedItem, 'provider' | 'type' | 'number' | 'linearIdentifier'> &
    Partial<Pick<WorkspaceLinkedItem, 'jiraIdentifier'>>
): string {
  if (item.provider === 'linear') {
    return item.linearIdentifier ?? `#${item.number}`
  }
  if (item.provider === 'jira') {
    return item.jiraIdentifier ?? `#${item.number}`
  }
  // Why: GitLab prints merge requests as `!<iid>` and issues as `#<iid>`, and the
  // two share an iid space per project, so dropping the sigil would make an MR and
  // an issue with the same iid read identically.
  return item.provider === 'gitlab' && item.type === 'mr' ? `!${item.number}` : `#${item.number}`
}

function fromLinkedWorkItem(
  item: WorkspaceLinkedItem,
  sourceContext: TaskSourceContext | null,
  workspaceRepoId: string | undefined
): WorkspaceLinkedTask {
  // Why: the link does not always record a repo. Items linked through a task
  // source carry the repo on the source context instead, and older links carry
  // it nowhere at all. Without a repo the panel has no path to read details
  // against, so fall back to the workspace's own repo before giving up.
  const repoId = item.repoId ?? workspaceRepoId ?? sourceContext?.repoId ?? undefined
  return {
    provider: item.provider,
    type: item.type,
    number: item.number,
    reference: formatWorkspaceLinkedTaskReference(item),
    title: item.title,
    url: item.url,
    ...(item.linearIdentifier ? { linearIdentifier: item.linearIdentifier } : {}),
    ...(item.jiraIdentifier ? { jiraIdentifier: item.jiraIdentifier } : {}),
    ...(repoId ? { repoId } : {}),
    sourceContext
  }
}

/** Resolves the linked item from the workspace's OWN link fields.
 *
 *  Why not the Tasks page selection: a workspace linked to a Jira issue must
 *  render that issue even while the Tasks page last showed a GitHub item.
 *
 *  `linkedWorkItem` wins because it is the only field carrying provider, title
 *  and URL together. The flat fields are the fallback for workspaces linked
 *  before that field existed, or linked by number from the meta dialog: they
 *  identify the item well enough to fetch it, and the panel fills the title and
 *  URL in from the provider cache. */
export function resolveWorkspaceLinkedTask(
  worktree: Pick<
    Worktree,
    | 'linkedWorkItem'
    | 'linkedTaskSourceContext'
    | 'linkedIssue'
    | 'linkedPR'
    | 'linkedLinearIssue'
    | 'linkedGitLabMR'
    | 'linkedGitLabIssue'
    | 'repoId'
  > | null
): WorkspaceLinkedTask | null {
  if (!worktree) {
    return null
  }
  const sourceContext = worktree.linkedTaskSourceContext ?? null
  if (worktree.linkedWorkItem) {
    return fromLinkedWorkItem(worktree.linkedWorkItem, sourceContext, worktree.repoId)
  }
  const legacy = ((): Omit<WorkspaceLinkedTask, 'reference' | 'sourceContext'> | null => {
    const repoId = worktree.repoId ?? sourceContext?.repoId ?? undefined
    const base = { title: '', url: '', ...(repoId ? { repoId } : {}) }
    if (worktree.linkedIssue !== null && worktree.linkedIssue !== undefined) {
      return { provider: 'github', type: 'issue', number: worktree.linkedIssue, ...base }
    }
    if (worktree.linkedPR !== null && worktree.linkedPR !== undefined) {
      return { provider: 'github', type: 'pr', number: worktree.linkedPR, ...base }
    }
    if (worktree.linkedGitLabMR !== null && worktree.linkedGitLabMR !== undefined) {
      return { provider: 'gitlab', type: 'mr', number: worktree.linkedGitLabMR, ...base }
    }
    if (worktree.linkedGitLabIssue !== null && worktree.linkedGitLabIssue !== undefined) {
      return { provider: 'gitlab', type: 'issue', number: worktree.linkedGitLabIssue, ...base }
    }
    if (worktree.linkedLinearIssue) {
      // Why: the flat Linear field stores the identifier (`ENG-31`), not a
      // number. Number stays 0 : the identifier is what every Linear read uses.
      return {
        provider: 'linear',
        type: 'issue',
        number: 0,
        linearIdentifier: worktree.linkedLinearIssue,
        ...base
      }
    }
    return null
  })()
  if (!legacy) {
    return null
  }
  return { ...legacy, reference: formatWorkspaceLinkedTaskReference(legacy), sourceContext }
}

export function hasWorkspaceLinkedTask(
  worktree: Parameters<typeof resolveWorkspaceLinkedTask>[0]
): boolean {
  return resolveWorkspaceLinkedTask(worktree) !== null
}
