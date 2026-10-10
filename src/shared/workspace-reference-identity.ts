import { parseJiraIssueUrl, JIRA_ISSUE_KEY_PATTERN } from './jira-issue-url'
import { parseLinearIssueInput, parseLinearIssueUrlIntent } from './linear/links'
import { getTaskSourceCacheScope } from './task-source-context'
import type { WorkspaceAttachment } from './worktree/types'

export type WorkspaceReferenceQuery =
  | { kind: 'url'; identity: string }
  // Self-hosted /owner/repo/issues/N cannot prove GitHub vs Gitea, so match type+host+path only.
  | { kind: 'issue-url'; route: string }
  | { kind: 'issue-key'; identifier: string }

const HOST_PROVIDERS: Readonly<Record<string, WorkspaceAttachment['provider']>> = {
  'github.com': 'github',
  'gitlab.com': 'gitlab',
  'linear.app': 'linear',
  'codeberg.org': 'gitea',
  'bitbucket.org': 'bitbucket',
  'dev.azure.com': 'azure-devops'
}

const CASE_INSENSITIVE_PATH_PROVIDERS: ReadonlySet<WorkspaceAttachment['provider']> = new Set([
  'github',
  'gitlab',
  'gitea'
])

function referenceUrl(input: string): URL {
  let url: URL
  try {
    url = new URL(input.trim())
  } catch {
    throw new Error('Expected a full reference URL (https://…).')
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Reference URLs must use HTTP or HTTPS and must not contain credentials.')
  }
  url.search = ''
  url.hash = ''
  url.pathname = url.pathname.replace(/\/+$/, '')
  if (url.hostname.startsWith('www.') && HOST_PROVIDERS[url.hostname.slice(4)]) {
    url.hostname = url.hostname.slice(4)
  }
  return url
}

function numberedReference(
  url: URL,
  provider: WorkspaceAttachment['provider'],
  type: WorkspaceAttachment['type'],
  path: string,
  rawNumber: string
): WorkspaceAttachment {
  const number = Number(rawNumber)
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error('Reference numbers must be positive safe integers.')
  }
  url.pathname = `${path}/${number}`
  return { provider, type, number, url: url.href }
}

export function parseWorkspaceReferenceUrl(
  input: string,
  providerHint?: WorkspaceAttachment['provider']
): WorkspaceAttachment {
  const url = referenceUrl(input)
  const knownProvider = HOST_PROVIDERS[url.hostname]
  const item = parseReferenceRoute(url, knownProvider ?? providerHint)
  if (
    (knownProvider && item.provider !== knownProvider) ||
    (providerHint && item.provider !== providerHint)
  ) {
    throw new Error('The reference URL does not match its provider.')
  }
  return item
}

function parseReferenceRoute(
  url: URL,
  providerHint?: WorkspaceAttachment['provider']
): WorkspaceAttachment {
  const linear = parseLinearIssueUrlIntent(url.href)
  if (linear) {
    url.pathname = `/${linear.organizationUrlKey.toLowerCase()}/issue/${linear.identifier}`
    return {
      provider: 'linear',
      type: 'issue',
      number: 0,
      identifier: linear.identifier,
      linearIdentifier: linear.identifier,
      linearOrganizationUrlKey: linear.organizationUrlKey.toLowerCase(),
      url: url.href
    }
  }
  // Git hosts (and Bitbucket Server /repos/ file views) also serve /browse/KEY-1 paths.
  const jira =
    (!providerHint || providerHint === 'jira') && !url.pathname.includes('/repos/')
      ? parseJiraIssueUrl(url.href)
      : null
  if (jira) {
    url.pathname = `${jira.sitePath}/browse/${jira.issueKey}`
    return {
      provider: 'jira',
      type: 'issue',
      number: 0,
      identifier: jira.issueKey,
      jiraIdentifier: jira.issueKey,
      url: url.href
    }
  }
  const gitlab = /^(\/.+)\/-\/(merge_requests|issues)\/(\d+)(?:\/.*)?$/.exec(url.pathname)
  if (gitlab && url.hostname !== 'github.com' && url.hostname !== 'linear.app') {
    return numberedReference(
      url,
      'gitlab',
      gitlab[2] === 'issues' ? 'issue' : 'mr',
      `${gitlab[1]}/-/${gitlab[2]}`,
      gitlab[3]
    )
  }
  const azure = /^(\/.+\/_git\/[^/]+)\/pullrequest\/(\d+)(?:\/.*)?$/.exec(url.pathname)
  if (azure) {
    return numberedReference(url, 'azure-devops', 'pr', `${azure[1]}/pullrequest`, azure[2])
  }
  const bitbucket = /^(\/.+)\/pull-requests\/(\d+)(?:\/.*)?$/.exec(url.pathname)
  if (
    bitbucket &&
    (url.hostname === 'bitbucket.org' ||
      /\/projects\/[^/]+\/repos\/[^/]+$/.test(bitbucket[1]) ||
      providerHint === 'bitbucket')
  ) {
    return numberedReference(url, 'bitbucket', 'pr', `${bitbucket[1]}/pull-requests`, bitbucket[2])
  }
  const git = /^(\/[^/]+\/[^/]+)\/(pull|pulls|issues)\/(\d+)(?:\/.*)?$/.exec(url.pathname)
  if (git && url.hostname !== 'linear.app' && url.hostname !== 'gitlab.com') {
    const provider =
      url.hostname === 'github.com' || git[2] === 'pull'
        ? 'github'
        : url.hostname === 'codeberg.org' || git[2] === 'pulls'
          ? 'gitea'
          : url.hostname === 'bitbucket.org'
            ? 'bitbucket'
            : providerHint
    if (provider === 'github' || provider === 'gitea' || provider === 'bitbucket') {
      if (
        (git[2] === 'pulls' && provider !== 'gitea') ||
        (git[2] === 'pull' && provider !== 'github')
      ) {
        throw new Error('The reference URL does not match its provider.')
      }
      return numberedReference(
        url,
        provider,
        git[2] === 'issues' ? 'issue' : 'pr',
        `${git[1]}/${git[2]}`,
        git[3]
      )
    }
  }
  throw new Error(
    'Unsupported reference URL. Use a PR, MR or issue URL with an identifiable provider route.'
  )
}

export function getWorkspaceReferenceIdentifier(item: WorkspaceAttachment): string | undefined {
  return item.identifier ?? item.linearIdentifier ?? item.jiraIdentifier
}

function externalUrl(item: WorkspaceAttachment): string | undefined {
  if (item.url) {
    return item.url
  }
  const identity = item.taskSourceContext?.providerIdentity
  const identifier = getWorkspaceReferenceIdentifier(item)
  if (item.provider === 'linear' && item.linearOrganizationUrlKey && identifier) {
    return `https://linear.app/${encodeURIComponent(item.linearOrganizationUrlKey)}/issue/${encodeURIComponent(identifier)}`
  }
  if (!identity || identity.provider !== item.provider) {
    return undefined
  }
  switch (identity.provider) {
    case 'github':
      return `https://${identity.host ?? 'github.com'}/${identity.owner}/${identity.repo}/${item.type === 'pr' ? 'pull' : 'issues'}/${item.number}`
    case 'gitlab':
      return identity.webUrl
        ? `${identity.webUrl.replace(/\/+$/, '')}/-/${item.type === 'mr' ? 'merge_requests' : 'issues'}/${item.number}`
        : undefined
    case 'jira':
      return identity.siteUrl && identifier
        ? `${identity.siteUrl.replace(/\/+$/, '')}/browse/${identifier}`
        : undefined
    case 'linear':
      return undefined
  }
}

/** Provider-proven external identity, or undefined when the source cannot be proven. */
export function getProvenWorkspaceReferenceIdentity(item: WorkspaceAttachment): string | undefined {
  const candidate = externalUrl(item)
  if (candidate) {
    try {
      const parsed = parseWorkspaceReferenceUrl(candidate, item.provider)
      const identifier = getWorkspaceReferenceIdentifier(item)
      if (
        parsed.provider === item.provider &&
        parsed.type === item.type &&
        (parsed.identifier
          ? parsed.identifier === identifier?.toUpperCase()
          : parsed.number === item.number)
      ) {
        const url = new URL(parsed.url!)
        // These hosts route case-insensitively; stored URLs keep the user's casing.
        const path = CASE_INSENSITIVE_PATH_PROVIDERS.has(parsed.provider)
          ? url.pathname.toLowerCase()
          : url.pathname
        return JSON.stringify([parsed.provider, parsed.type, url.host, path])
      }
    } catch {
      // Legacy links without a provable source remain removable by their opaque key.
    }
  }
  return undefined
}

export function getWorkspaceReferenceIdentity(item: WorkspaceAttachment): string {
  return (
    getProvenWorkspaceReferenceIdentity(item) ??
    JSON.stringify([
      'legacy',
      item.provider,
      item.type,
      getWorkspaceReferenceIdentifier(item) ?? item.number,
      item.taskSourceContext ? getTaskSourceCacheScope(item.taskSourceContext) : '',
      item.repoId ?? '',
      item.linearWorkspaceId ?? '',
      item.linearOrganizationUrlKey ?? '',
      item.url ?? ''
    ])
  )
}

export function parseWorkspaceReferenceQuery(input: string): WorkspaceReferenceQuery {
  const value = input.trim()
  const linear = parseLinearIssueInput(value)
  if (JIRA_ISSUE_KEY_PATTERN.test(value) || (linear && !value.includes('://'))) {
    return { kind: 'issue-key', identifier: value.toUpperCase() }
  }
  try {
    return {
      kind: 'url',
      identity: getWorkspaceReferenceIdentity(parseWorkspaceReferenceUrl(value))
    }
  } catch (error) {
    let route: string | undefined
    try {
      const issue = parseWorkspaceReferenceUrl(value, 'github')
      route = issue.type === 'issue' ? referenceRoute(issue) : undefined
    } catch {
      throw error
    }
    if (!route) {
      throw error
    }
    return { kind: 'issue-url', route }
  }
}

function referenceRoute(item: WorkspaceAttachment): string | undefined {
  const identity = getProvenWorkspaceReferenceIdentity(item)
  const parsed: unknown = identity ? JSON.parse(identity) : undefined
  return Array.isArray(parsed) ? JSON.stringify(parsed.slice(1)) : undefined
}

export function matchesWorkspaceReferenceQuery(
  item: WorkspaceAttachment,
  query: WorkspaceReferenceQuery
): boolean {
  if (query.kind === 'url') {
    return getWorkspaceReferenceIdentity(item) === query.identity
  }
  if (query.kind === 'issue-url') {
    return (
      (item.provider === 'github' || item.provider === 'gitea') &&
      referenceRoute(item) === query.route
    )
  }
  return (
    item.type === 'issue' &&
    getWorkspaceReferenceIdentifier(item)?.toUpperCase() === query.identifier
  )
}
