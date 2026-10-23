import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { getMatchingJiraSites, parseJiraIssueUrl } from '../../../../shared/jira-issue-url'
import type { JiraSite } from '../../../../shared/jira-types'
import {
  buildGitHubWorkspaceSource,
  buildGitLabWorkspaceSource,
  buildLinearWorkspaceSource,
  buildJiraWorkspaceSource,
  type WorkspaceSourceLinkedItem
} from '../../../../shared/new-workspace/workspace-source'
import { parseGitHubIssueOrPRLink } from '../../../../shared/github/links'
import { parseGitLabIssueOrMRLink } from '../../../../shared/new-workspace/gitlab-links'
import { bindJiraIssueSourceContext } from './use-jira-url-source'
import type { RowEntry } from './smart-workspace-name-field-model'

export type WorkItemSourceContexts = Record<
  'github' | 'gitlab' | 'linear' | 'jira',
  TaskSourceContext | null
>
export function resolveWorkItemSourceRow(
  row: RowEntry,
  contexts: WorkItemSourceContexts,
  sites: readonly JiraSite[] = []
):
  | (WorkspaceSourceLinkedItem & { identifier?: string; taskSourceContext?: TaskSourceContext })
  | null {
  if (row.kind === 'github' || row.kind === 'gitlab') {
    const { type, number, title, url, repoId } = row.item
    const source =
      row.kind === 'github'
        ? buildGitHubWorkspaceSource({ ...row.item, type: row.item.type })
        : buildGitLabWorkspaceSource(row.item)
    const context = contexts[row.kind]
    const github = row.kind === 'github' ? parseGitHubIssueOrPRLink(url) : null
    const gitlab = row.kind === 'gitlab' ? parseGitLabIssueOrMRLink(url) : null
    const identity = github
      ? { provider: 'github' as const, ...github.slug }
      : gitlab
        ? { provider: 'gitlab' as const, webUrl: `${new URL(url).origin}/${gitlab.slug.path}` }
        : context?.providerIdentity
    return {
      provider: source.provider,
      type,
      number,
      title,
      url,
      repoId,
      taskSourceContext: context ? { ...context, providerIdentity: identity } : undefined
    }
  }
  if (row.kind === 'linear') {
    const { linearBranchName: _branchName, ...source } = buildLinearWorkspaceSource(row.issue)
    return {
      ...source,
      identifier: row.issue.identifier,
      taskSourceContext: contexts.linear
        ? {
            ...contexts.linear,
            providerIdentity: {
              provider: 'linear',
              workspaceId: row.issue.workspaceId,
              workspaceName: row.issue.workspaceName,
              teamId: row.issue.team.id,
              teamKey: row.issue.team.key
            }
          }
        : undefined
    }
  }
  if (row.kind === 'jira') {
    const parsed = parseJiraIssueUrl(row.issue.url)
    const site =
      sites.find((site) => site.id === row.issue.siteId) ??
      (!row.issue.siteId && sites.length === 1 ? sites[0] : null)
    const source = contexts.jira
    const identity = source?.providerIdentity
    const boundUrl =
      identity?.provider === 'jira' && identity.siteUrl
        ? parseJiraIssueUrl(`${identity.siteUrl.replace(/\/+$/, '')}/browse/${row.issue.key}`)
        : null
    const boundMatches =
      identity?.provider === 'jira' &&
      (!row.issue.siteId || row.issue.siteId === identity.siteId) &&
      parsed &&
      boundUrl &&
      parsed.origin === boundUrl.origin &&
      parsed.sitePath === boundUrl.sitePath
    const context =
      source && site && parsed && getMatchingJiraSites(parsed, [site]).length
        ? bindJiraIssueSourceContext(source, site, row.issue)
        : boundMatches
          ? source
          : null
    return context
      ? {
          ...buildJiraWorkspaceSource(row.issue),
          identifier: row.issue.key,
          taskSourceContext: context
        }
      : null
  }
  return null
}
