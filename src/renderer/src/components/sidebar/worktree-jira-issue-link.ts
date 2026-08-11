import { getMatchingJiraSites } from '../../../../shared/jira-issue-url'
import {
  normalizeTaskSourceContext,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import type { ParsedIssueLinkInput } from '../../../../shared/issue-link-input'
import type { JiraConnectionStatus, JiraIssue, JiraSite } from '../../../../shared/jira-types'
import type { WorkspaceLinkedItem } from '../../../../shared/types'

export type ParsedJiraIssueLink = Extract<ParsedIssueLinkInput, { provider: 'jira' }>

export type JiraIssueLinkErrorKind =
  | 'not-connected'
  | 'site-not-connected'
  | 'ambiguous-site'
  | 'not-found'

type JiraSiteResolution =
  | { site: JiraSite }
  | { errorKind: Exclude<JiraIssueLinkErrorKind, 'not-found'> }

/** Picks the Jira site a link resolves against: a URL pins the site it names, a
 *  bare key uses the active site, then the selected site, then the only connected
 *  site. Several connected sites with none active or selected is ambiguous: the
 *  same key can exist on two instances, so guessing would link the wrong ticket.
 *  Mirrors the CLI `worktree set --jira` contract. */
export function selectJiraSiteForLink(
  parsed: Pick<ParsedJiraIssueLink, 'siteOrigin' | 'sitePath'>,
  status: JiraConnectionStatus
): JiraSiteResolution {
  const sites = status.sites ?? []
  if (!status.connected || sites.length === 0) {
    return { errorKind: 'not-connected' }
  }

  if (parsed.siteOrigin) {
    const pinned = getMatchingJiraSites(
      { issueKey: '', origin: parsed.siteOrigin, sitePath: parsed.sitePath ?? '' },
      sites
    )[0]
    return pinned ? { site: pinned } : { errorKind: 'site-not-connected' }
  }

  const active = sites.find((site) => site.id === status.activeSiteId)
  if (active) {
    return { site: active }
  }
  const selected =
    typeof status.selectedSiteId === 'string'
      ? sites.find((site) => site.id === status.selectedSiteId)
      : undefined
  if (selected) {
    return { site: selected }
  }
  return sites.length > 1 ? { errorKind: 'ambiguous-site' } : { site: sites[0] }
}

/** Jira keys are not numeric, so the shared numeric field carries no meaning; the
 *  identifier is what the card renders. Matches the CLI-built work item shape. */
export function buildJiraLinkedWorkItem(issue: JiraIssue): WorkspaceLinkedItem {
  return {
    provider: 'jira',
    type: 'issue',
    number: 0,
    title: issue.title,
    url: issue.url,
    jiraIdentifier: issue.key
  }
}

/** Binds the resolved site and issue into a Jira task-source context so the card
 *  can scope reads and match the link. Reuses the base context's project, host,
 *  and repo, and normalizes to null when those are incomplete. */
export function buildJiraLinkedTaskSourceContext(
  base: TaskSourceContext,
  site: JiraSite,
  issue: JiraIssue
): TaskSourceContext | null {
  return normalizeTaskSourceContext({
    provider: 'jira',
    projectId: base.projectId,
    hostId: base.hostId,
    projectHostSetupId: base.projectHostSetupId,
    repoId: base.repoId,
    providerIdentity: {
      provider: 'jira',
      siteId: site.id,
      siteUrl: site.siteUrl,
      projectKey: issue.project.key
    },
    accountLabel: site.email || site.displayName
  })
}

export type JiraIssueLinkResult =
  | {
      ok: true
      linkedWorkItem: WorkspaceLinkedItem
      linkedTaskSourceContext: TaskSourceContext | null
    }
  | { ok: false; errorKind: JiraIssueLinkErrorKind }

/** Resolves a typed Jira input into the `linkedWorkItem` the workspace stores.
 *  Failing to resolve is a hard error rather than a partial link: a card showing
 *  a key with no title or URL is worse than no link, and the renderer expects both. */
export async function resolveJiraIssueLink(args: {
  parsed: ParsedJiraIssueLink
  sourceContext: TaskSourceContext
  readStatus: (context: TaskSourceContext) => Promise<JiraConnectionStatus>
  lookupSummary: (
    context: TaskSourceContext,
    key: string,
    siteId: string
  ) => Promise<JiraIssue | null>
}): Promise<JiraIssueLinkResult> {
  const status = await args.readStatus(args.sourceContext)
  const resolution = selectJiraSiteForLink(args.parsed, status)
  if ('errorKind' in resolution) {
    return { ok: false, errorKind: resolution.errorKind }
  }

  const issue = await args.lookupSummary(
    args.sourceContext,
    args.parsed.issueKey,
    resolution.site.id
  )
  if (!issue) {
    return { ok: false, errorKind: 'not-found' }
  }

  return {
    ok: true,
    linkedWorkItem: buildJiraLinkedWorkItem(issue),
    linkedTaskSourceContext: buildJiraLinkedTaskSourceContext(
      args.sourceContext,
      resolution.site,
      issue
    )
  }
}
