import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { getLinkedWorkItemProvider, isGitLabIssueUrl } from '@/lib/new-workspace'
import { runIssueUpdate } from '@/components/github/github-work-item-edit-mutations'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

export const GITHUB_START_ASSIGNEE_ME = '@me'

export type GitHubIssueStartAssignmentItem = {
  provider?: string | null
  type: string
  number: number | null
  url?: string
  assignees?: readonly ({ login?: string | null } | string)[] | null
  linearIdentifier?: string
  jiraIdentifier?: string
}

export type AssignUnassignedGitHubIssueOnStartArgs = {
  enabled: boolean
  item: GitHubIssueStartAssignmentItem | null | undefined
  repoId: string
  sourceContext?: TaskSourceContext | null
}

export type AssignUnassignedGitHubIssueOnStartDeps = {
  resolveCurrentUserLogin?: () => Promise<string | null>
  addAssignees?: (args: {
    repoId: string
    number: number
    logins: string[]
    sourceContext?: TaskSourceContext | null
  }) => Promise<void>
  patchWorkItem?: (
    itemId: string,
    patch: Partial<GitHubWorkItem>,
    repoId?: string | null,
    options?: { sourceContext?: TaskSourceContext | null }
  ) => void
  onFailure?: (message: string) => void
}

export type AssignUnassignedGitHubIssueOnStartResult = 'assigned' | 'skipped' | 'failed'

function assigneeLogin(assignee: { login?: string | null } | string): string {
  return (typeof assignee === 'string' ? assignee : assignee.login)?.trim() ?? ''
}

export function githubIssueHasAssignees(
  assignees: GitHubIssueStartAssignmentItem['assignees']
): boolean {
  return (assignees ?? []).some((assignee) => assigneeLogin(assignee).length > 0)
}

export function isGitHubIssueForStartAssignment(
  item: GitHubIssueStartAssignmentItem | null | undefined
): boolean {
  if (!item || item.type !== 'issue' || item.number == null || item.number < 1) {
    return false
  }
  if (item.linearIdentifier || item.jiraIdentifier) {
    return false
  }
  if (item.url && isGitLabIssueUrl(item.url)) {
    return false
  }
  if (item.provider) {
    return item.provider === 'github'
  }
  if (!item.url || (item.type !== 'issue' && item.type !== 'pr' && item.type !== 'mr')) {
    return true
  }
  return (
    getLinkedWorkItemProvider({
      type: item.type,
      number: item.number,
      title: '',
      url: item.url
    }) === 'github'
  )
}

export function shouldAssignUnassignedGitHubIssueOnStart(
  args: Pick<AssignUnassignedGitHubIssueOnStartArgs, 'enabled' | 'item'>
): boolean {
  if (!args.enabled || !isGitHubIssueForStartAssignment(args.item) || !args.item) {
    return false
  }
  // Why: missing assignee data is not proof the issue is unassigned, so skip
  // rather than adding the current user next to someone already on the issue.
  if (args.item.assignees == null) {
    return false
  }
  return !githubIssueHasAssignees(args.item.assignees)
}

export function assignUnassignedGitHubIssueOnStartFailureMessage(): string {
  return translate(
    'auto.lib.assign.unassigned.github.issue.on.start.failed',
    "Couldn't assign the GitHub issue to you. The workspace was still created."
  )
}

export async function resolveGitHubStartAssigneeLogin(
  sourceContext?: TaskSourceContext | null
): Promise<string> {
  // Why: runtime github.updateIssue uses that host's gh session; desktop gh:viewer is a different account.
  if (sourceContext?.hostId.startsWith('runtime:')) {
    return GITHUB_START_ASSIGNEE_ME
  }
  try {
    const login = (await window.api.gh.viewer())?.login?.trim()
    if (login) {
      return login
    }
  } catch {
    // gh issue edit still accepts @me for the authenticated account.
  }
  return GITHUB_START_ASSIGNEE_ME
}

async function defaultAddAssignees(args: {
  repoId: string
  number: number
  logins: string[]
  sourceContext?: TaskSourceContext | null
}): Promise<void> {
  const repo = useAppStore.getState().repos.find((entry) => entry.id === args.repoId)
  await runIssueUpdate({
    repoPath: repo?.path ?? null,
    repoId: args.repoId,
    sourceContext: args.sourceContext,
    projectOrigin: undefined,
    number: args.number,
    updates: { addAssignees: args.logins }
  })
}

export async function assignUnassignedGitHubIssueOnStart(
  args: AssignUnassignedGitHubIssueOnStartArgs,
  deps: AssignUnassignedGitHubIssueOnStartDeps = {}
): Promise<AssignUnassignedGitHubIssueOnStartResult> {
  if (!shouldAssignUnassignedGitHubIssueOnStart(args) || args.item?.number == null) {
    return 'skipped'
  }

  const resolveCurrentUserLogin =
    deps.resolveCurrentUserLogin ?? (() => resolveGitHubStartAssigneeLogin(args.sourceContext))
  const addAssignees = deps.addAssignees ?? defaultAddAssignees
  const patchWorkItem =
    deps.patchWorkItem ??
    ((itemId, patch, repoId, options) => {
      useAppStore.getState().patchWorkItem(itemId, patch, repoId, options)
    })
  const onFailure = deps.onFailure ?? ((message) => toast.error(message))

  let login: string
  try {
    login = (await resolveCurrentUserLogin())?.trim() || GITHUB_START_ASSIGNEE_ME
    await addAssignees({
      repoId: args.repoId,
      number: args.item.number,
      logins: [login],
      sourceContext: args.sourceContext
    })
  } catch {
    onFailure(assignUnassignedGitHubIssueOnStartFailureMessage())
    return 'failed'
  }

  // Why: `@me` is not a real login; AssigneesCell would show a fake chip until refetch.
  if (login !== GITHUB_START_ASSIGNEE_ME) {
    patchWorkItem(
      `issue:${args.item.number}`,
      { assignees: [{ login, name: null, avatarUrl: '' }] },
      args.repoId,
      { sourceContext: args.sourceContext }
    )
  }
  return 'assigned'
}
