import type { Repo } from '../../repo-types'
import { parseGitHubIssueOrPRLink } from '../repositories/links'
import {
  githubHostFromIdentityKey,
  repoUpstreamIdentityKey
} from '../repositories/repository-identity-key'

export type GitHubRepoReference = {
  owner: string
  repo: string
}

/** Issue or PR number to the github.com repo a URL with that number named. */
export type GitHubSeenReferenceRepos = ReadonlyMap<string, GitHubRepoReference>

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  title?: string | null
  children?: MarkdownNode[]
}

const GITHUB_REFERENCE_PATTERN = /(?:\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g
const GITHUB_ITEM_URL_PATTERN = /https?:\/\/github\.com\/[^\s"'<>()[\]`]+/gi
const TRAILING_URL_PUNCTUATION_PATTERN = /[.,;:!?*_~]+$/

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

/** Repos that github.com issue and PR URLs in `text` name, by number; a later URL wins. */
export function collectGitHubSeenReferenceRepos(
  text: string,
  into: Map<string, GitHubRepoReference>
): void {
  if (!text.includes('github.com/')) {
    return
  }
  for (const [url] of text.matchAll(GITHUB_ITEM_URL_PATTERN)) {
    const link = parseGitHubIssueOrPRLink(url.replace(TRAILING_URL_PUNCTUATION_PATTERN, ''))
    if (link && link.slug.host?.toLowerCase() === 'github.com') {
      const key = String(link.number)
      // Re-insert so iteration order follows the latest sighting.
      into.delete(key)
      into.set(key, { owner: link.slug.owner, repo: link.slug.repo })
    }
  }
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

function splitGitHubReferenceText(
  value: string,
  defaultRepo: GitHubRepoReference,
  seenRepos: GitHubSeenReferenceRepos | undefined
): MarkdownNode[] {
  const parts: MarkdownNode[] = []
  let cursor = 0

  for (const match of value.matchAll(GITHUB_REFERENCE_PATTERN)) {
    const label = match[0]
    const index = match.index ?? 0
    if (isEmbeddedGitHubReference(value, index)) {
      continue
    }

    const number = match[3]
    if (!number) {
      continue
    }
    // A bare #N follows a URL seen with that number before the chat's own repo.
    const target = (!match[1] && seenRepos?.get(number)) || defaultRepo
    const owner = match[1] ?? target.owner
    const repo = match[2] ?? target.repo

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

/** Turns `#123` and `owner/repo#123` in an mdast tree's text into issue links, in place. */
export function linkGitHubReferences(
  node: MarkdownNode,
  defaultRepo: GitHubRepoReference,
  seenRepos?: GitHubSeenReferenceRepos
): void {
  if (!node.children || node.type === 'link' || node.type === 'image') {
    return
  }

  const nextChildren: MarkdownNode[] = []
  for (const child of node.children) {
    if (child.type === 'text' && child.value !== undefined) {
      // Agent replies can contain thousands of issue refs; append iteratively to avoid V8’s argument limit.
      for (const part of splitGitHubReferenceText(child.value, defaultRepo, seenRepos)) {
        nextChildren.push(part)
      }
    } else {
      linkGitHubReferences(child, defaultRepo, seenRepos)
      nextChildren.push(child)
    }
  }

  node.children = nextChildren
}
