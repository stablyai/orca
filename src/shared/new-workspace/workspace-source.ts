import { getLinearOrganizationUrlKeyFromIssueUrl } from '../linear/links'
import type { FolderWorkspaceLinkedTask } from '../folder-workspace-types'
import type { JiraIssue } from '../jira-types'
import type { LinearIssue } from '../linear/issue-types'
import {
  getLinkedWorkItemSuggestedName,
  getLinkedWorkItemWorkspaceName,
  type WorkspaceIntentWorkItem
} from '../workspace-name'
import { isWorkItemLookupText } from './work-item-lookup-text'

export type WorkspaceSourceProvider = FolderWorkspaceLinkedTask['provider']

export type WorkspaceSourceLinkedItem = FolderWorkspaceLinkedTask & {
  linearWorkspaceId?: string
  linearOrganizationUrlKey?: string
  linearBranchName?: string
}

export type GitHubWorkspaceSource = WorkspaceSourceLinkedItem & {
  provider: 'github'
  type: 'issue' | 'pr'
}

export type GitLabWorkspaceSource = WorkspaceSourceLinkedItem & {
  provider: 'gitlab'
  type: 'issue' | 'mr'
}

export type LinearWorkspaceSource = WorkspaceSourceLinkedItem & {
  provider: 'linear'
  type: 'issue'
}

export type JiraWorkspaceSource = WorkspaceSourceLinkedItem & {
  provider: 'jira'
  type: 'issue'
}

export type PluginWorkspaceSource = WorkspaceSourceLinkedItem & {
  provider: 'plugin'
  type: 'issue'
}

export type WorkspaceSourceItemLike = Omit<WorkspaceSourceLinkedItem, 'provider'> & {
  provider?: WorkspaceSourceProvider
}

export type WorkspaceSourceSelectionKind =
  | 'github-pr'
  | 'github-issue'
  | 'gitlab-mr'
  | 'gitlab-issue'
  | 'branch'
  | 'linear'
  | 'jira'
  | 'plugin'

export type WorkspaceSourceSelection = {
  kind: WorkspaceSourceSelectionKind
  label: string
  url?: string
  /** Which contributed source produced a `plugin` selection. The renderer needs
   *  it to draw that plugin's own icon rather than a generic one. */
  pluginKey?: string
  sourceId?: string
}

const GITLAB_ISSUE_PATH_RE = /\/-\/(?:issues|work_items)\//i

export function isGitLabIssueUrl(url: string): boolean {
  try {
    return GITLAB_ISSUE_PATH_RE.test(new URL(url).pathname)
  } catch {
    return GITLAB_ISSUE_PATH_RE.test(url)
  }
}

function isJiraIssueUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return (
      /\.atlassian\.net$/i.test(parsed.hostname) ||
      /\/browse\/[A-Z][A-Z0-9]+-\d+/i.test(parsed.pathname)
    )
  } catch {
    return false
  }
}

export function getWorkspaceSourceProvider(item: WorkspaceSourceItemLike): WorkspaceSourceProvider {
  if (item.provider) {
    return item.provider
  }
  if (item.linearIdentifier) {
    return 'linear'
  }
  if (item.jiraIdentifier || isJiraIssueUrl(item.url)) {
    return 'jira'
  }
  if (item.type === 'mr' || isGitLabIssueUrl(item.url)) {
    return 'gitlab'
  }
  if (item.number === 0 && !item.url.includes('github.com')) {
    return 'linear'
  }
  return 'github'
}

export function buildGitHubWorkspaceSource(item: {
  type: 'issue' | 'pr'
  number: number
  title: string
  url: string
  repoId?: string
}): GitHubWorkspaceSource {
  return { provider: 'github', ...item }
}

export function buildGitLabWorkspaceSource(item: {
  type: 'issue' | 'mr'
  number: number
  title: string
  url: string
  repoId?: string
}): GitLabWorkspaceSource {
  return { provider: 'gitlab', ...item }
}

export function getUsableLinearBranchName(
  branchName: string | null | undefined
): string | undefined {
  // Why: only a non-blank normalized value can safely enter the exact git-ref
  // override path; missing values must keep Orca's generated-name fallback.
  return branchName?.trim() || undefined
}

export function buildLinearWorkspaceSource(
  issue: Pick<LinearIssue, 'identifier' | 'title' | 'url' | 'workspaceId' | 'branchName'>
): LinearWorkspaceSource {
  const organizationUrlKey = getLinearOrganizationUrlKeyFromIssueUrl(issue.url)
  const branchName = getUsableLinearBranchName(issue.branchName)
  return {
    provider: 'linear',
    type: 'issue',
    // Why: Linear uses a string identifier; numeric issue metadata must stay empty.
    number: 0,
    title: issue.title,
    url: issue.url,
    linearIdentifier: issue.identifier,
    ...(issue.workspaceId ? { linearWorkspaceId: issue.workspaceId } : {}),
    ...(organizationUrlKey ? { linearOrganizationUrlKey: organizationUrlKey } : {}),
    ...(branchName ? { linearBranchName: branchName } : {})
  }
}

export function buildJiraWorkspaceSource(
  issue: Pick<JiraIssue, 'key' | 'title' | 'url'>
): JiraWorkspaceSource {
  return {
    provider: 'jira',
    type: 'issue',
    number: 0,
    title: issue.title,
    url: issue.url,
    jiraIdentifier: issue.key
  }
}

/** A contributed item's key ('AB-41') has no field of its own on the linked
 *  item, so it leads the title — the same text the composer already seeds its
 *  name from. `number` stays 0 for the same reason Linear and Jira keep it 0. */
export function buildPluginWorkspaceSource(item: {
  key: string
  title: string
  url: string
  pluginKey: string
  sourceId: string
}): PluginWorkspaceSource {
  return {
    provider: 'plugin',
    type: 'issue',
    number: 0,
    title: `${item.key} ${item.title}`.trim(),
    url: item.url,
    pluginKey: item.pluginKey,
    sourceId: item.sourceId
  }
}

export function shouldApplyWorkspaceSourceAutoName(args: {
  currentName: string
  lastAutoName: string
}): boolean {
  return (
    !args.currentName.trim() ||
    args.currentName === args.lastAutoName ||
    isWorkItemLookupText(args.currentName)
  )
}

function toWorkspaceIntentItem(item: WorkspaceSourceItemLike): WorkspaceIntentWorkItem {
  return { ...item, provider: getWorkspaceSourceProvider(item) }
}

export function getWorkspaceSourceName(item: WorkspaceSourceItemLike): {
  seedName: string
  displayName: string
} {
  const normalized = toWorkspaceIntentItem(item)
  const resolved = getLinkedWorkItemWorkspaceName(normalized)
  return {
    seedName: resolved?.seedName ?? getLinkedWorkItemSuggestedName(normalized),
    displayName: resolved?.displayName ?? item.title.trim()
  }
}

// No `default`: a new provider must fail to compile here rather than silently
// render as a GitHub issue.
function getWorkspaceSourceSelectionKind(
  provider: WorkspaceSourceProvider,
  type: WorkspaceSourceItemLike['type']
): WorkspaceSourceSelectionKind {
  switch (provider) {
    case 'linear':
      return 'linear'
    case 'jira':
      return 'jira'
    case 'plugin':
      return 'plugin'
    case 'gitlab':
      return type === 'mr' ? 'gitlab-mr' : 'gitlab-issue'
    case 'github':
      return type === 'pr' ? 'github-pr' : 'github-issue'
  }
}

export function buildWorkspaceSourceSelection(args: {
  linkedWorkItem: WorkspaceSourceItemLike | null
  baseBranch?: string
}): WorkspaceSourceSelection | null {
  const { linkedWorkItem, baseBranch } = args
  if (!linkedWorkItem) {
    return baseBranch ? { kind: 'branch', label: baseBranch } : null
  }
  const provider = getWorkspaceSourceProvider(linkedWorkItem)
  return {
    kind: getWorkspaceSourceSelectionKind(provider, linkedWorkItem.type),
    label:
      provider === 'linear' ||
      provider === 'jira' ||
      provider === 'plugin' ||
      linkedWorkItem.number === 0
        ? linkedWorkItem.title
        : `#${linkedWorkItem.number} ${linkedWorkItem.title}`,
    url: linkedWorkItem.url,
    ...(provider === 'plugin'
      ? { pluginKey: linkedWorkItem.pluginKey, sourceId: linkedWorkItem.sourceId }
      : {})
  }
}

export function shouldPreserveWorkspaceSourceOnRepoChange(
  item: WorkspaceSourceItemLike | null
): boolean {
  if (!item) {
    return false
  }
  const provider = getWorkspaceSourceProvider(item)
  // Account-backed sources, contributed ones included, are not tied to the
  // selected repo, so switching repo must not drop the selection.
  return provider === 'linear' || provider === 'jira' || provider === 'plugin'
}
