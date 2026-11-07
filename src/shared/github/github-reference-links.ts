import type { Repo } from '../repo-types'
import { githubHostFromIdentityKey, repoUpstreamIdentityKey } from './repository-identity-key'

export type GitHubRepoReference = {
  owner: string
  repo: string
}

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  title?: string | null
  children?: MarkdownNode[]
}

const GITHUB_REFERENCE_PATTERN = /(?:\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g
const GITHUB_URL_REPO_PATTERN =
  /\bhttps?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi
const GITHUB_ISSUE_NUMBER_PATTERN = /#[1-9][0-9]*\b/g
const REPO_NAME_CHARACTER = /[A-Za-z0-9_.-]/
// First URL path segments on github.com that are site pages, not repo owners.
const NON_REPO_GITHUB_PATHS = new Set([
  'advisories',
  'apps',
  'collections',
  'enterprise',
  'features',
  'issues',
  'login',
  'marketplace',
  'orgs',
  'pulls',
  'security',
  'settings',
  'site',
  'sponsors',
  'topics',
  'user-attachments',
  'users'
])

/** Where bare `#123` points: upstream unless the repo prefers origin. github.com only. */
export function githubReferenceRepo(
  repo: Pick<Repo, 'upstream' | 'issueSourcePreference'>,
  originIdentityKey: string
): GitHubRepoReference | null {
  const upstreamKey = repoUpstreamIdentityKey(repo, originIdentityKey)
  const key =
    upstreamKey && repo.issueSourcePreference !== 'origin' ? upstreamKey : originIdentityKey
  if (githubHostFromIdentityKey(key)) {
    return null
  }
  const [owner, name] = key.split('/')
  return owner && name ? { owner, repo: name } : null
}

function createGitHubIssueUrl(owner: string, repo: string, number: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`
}

function isEmbeddedGitHubReference(value: string, index: number): boolean {
  if (index === 0) {
    return false
  }
  return /[A-Za-z0-9_./-]/.test(value[index - 1] ?? '')
}

function repoNameSegmentStart(text: string, end: number): number {
  let start = end
  while (start > 0 && REPO_NAME_CHARACTER.test(text[start - 1])) {
    start -= 1
  }
  return start
}

function namesAnotherGitHubRepo(text: string, repo: GitHubRepoReference): boolean {
  const isOtherRepo = (owner: string, name: string): boolean =>
    owner.toLowerCase() !== repo.owner.toLowerCase() ||
    name.toLowerCase() !== repo.repo.toLowerCase()
  // Why: this scans whole code blocks on every streamed chunk, where GITHUB_REFERENCE_PATTERN is quadratic on dotted tokens.
  for (const match of text.matchAll(GITHUB_ISSUE_NUMBER_PATTERN)) {
    const nameStart = repoNameSegmentStart(text, match.index)
    const ownerEnd = nameStart - 1
    if (nameStart === match.index || text[ownerEnd] !== '/') {
      continue
    }
    const ownerStart = repoNameSegmentStart(text, ownerEnd)
    if (
      ownerStart < ownerEnd &&
      /\w/.test(text[ownerStart]) &&
      !isEmbeddedGitHubReference(text, ownerStart) &&
      isOtherRepo(text.slice(ownerStart, ownerEnd), text.slice(nameStart, match.index))
    ) {
      return true
    }
  }
  for (const [, owner, name] of text.matchAll(GITHUB_URL_REPO_PATTERN)) {
    if (
      !NON_REPO_GITHUB_PATHS.has(owner.toLowerCase()) &&
      isOtherRepo(owner, name.replace(/\.+$/, '').replace(/\.git$/i, ''))
    ) {
      return true
    }
  }
  return false
}

/** Chat text can discuss any repo, so bare `#123` only means the workspace's when no other is
 *  named outside code. `codeLines` is the caller's Markdown engine, so it agrees with what is drawn. */
export function bareGitHubReferenceRepoForChat(
  text: string,
  workspaceRepo: GitHubRepoReference | null | undefined,
  codeLines: (text: string) => ReadonlySet<number>
): GitHubRepoReference | null {
  if (!workspaceRepo) {
    return null
  }
  // Removing code only removes matches, so most messages never pay for a parse while streaming.
  if (!namesAnotherGitHubRepo(text, workspaceRepo)) {
    return workspaceRepo
  }
  const code = codeLines(text)
  const prose = text
    .split(/\r\n?|\n/)
    .filter((_, line) => !code.has(line))
    .join('\n')
  return namesAnotherGitHubRepo(prose, workspaceRepo) ? null : workspaceRepo
}

function splitGitHubReferenceText(
  value: string,
  defaultRepo: GitHubRepoReference | null
): MarkdownNode[] {
  const parts: MarkdownNode[] = []
  let cursor = 0

  for (const match of value.matchAll(GITHUB_REFERENCE_PATTERN)) {
    const label = match[0]
    const index = match.index ?? 0
    if (isEmbeddedGitHubReference(value, index)) {
      continue
    }

    const owner = match[1] ?? defaultRepo?.owner
    const repo = match[2] ?? defaultRepo?.repo
    const number = match[3]
    if (!owner || !repo || !number) {
      continue
    }

    if (index > cursor) {
      parts.push({ type: 'text', value: value.slice(cursor, index) })
    }
    parts.push({
      type: 'link',
      url: createGitHubIssueUrl(owner, repo, number),
      title: null,
      children: [{ type: 'text', value: label }]
    })
    cursor = index + label.length
  }

  if (cursor === 0) {
    return [{ type: 'text', value }]
  }
  if (cursor < value.length) {
    parts.push({ type: 'text', value: value.slice(cursor) })
  }
  return parts
}

/** Turns `#123` and `owner/repo#123` in an mdast tree's text into issue links, in place. A null
 *  `defaultRepo` leaves bare `#123` as text. */
export function linkGitHubReferences(
  node: MarkdownNode,
  defaultRepo: GitHubRepoReference | null
): void {
  if (!node.children || node.type === 'link' || node.type === 'image') {
    return
  }

  const nextChildren: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      // Agent replies can contain thousands of issue refs; append iteratively to avoid V8’s argument limit.
      for (const part of splitGitHubReferenceText(child.value, defaultRepo)) {
        nextChildren.push(part)
      }
    } else {
      linkGitHubReferences(child, defaultRepo)
      nextChildren.push(child)
    }
  }

  node.children = nextChildren
}
