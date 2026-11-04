import type { Repo } from '../repo-types'
import { githubHostFromIdentityKey, githubRepoIdentityKey } from './repository-identity-key'

export type GitHubRepoReference = {
  owner: string
  repo: string
}

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  title?: null
  children?: MarkdownNode[]
}

const GITHUB_REFERENCE_PATTERN = /(?:\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g

/** Fork-parent alias, or null if untrusted. Require resolved origin identity as host fallback for older upstream metadata, or GHES parents could collapse into github.com. */
export function repoUpstreamIdentityKey(
  repo: Pick<Repo, 'upstream'>,
  originIdentityKey: string | null | undefined
): string | null {
  const upstream = repo.upstream
  if (!upstream?.owner || !upstream.repo || !originIdentityKey) {
    return null
  }
  return githubRepoIdentityKey({
    ...upstream,
    host: upstream.host ?? githubHostFromIdentityKey(originIdentityKey)
  })
}

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

function splitGitHubReferenceText(value: string, defaultRepo: GitHubRepoReference): MarkdownNode[] {
  const parts: MarkdownNode[] = []
  let cursor = 0

  for (const match of value.matchAll(GITHUB_REFERENCE_PATTERN)) {
    const label = match[0]
    const index = match.index ?? 0
    if (isEmbeddedGitHubReference(value, index)) {
      continue
    }

    const owner = match[1] ?? defaultRepo.owner
    const repo = match[2] ?? defaultRepo.repo
    const number = match[3]
    if (!number) {
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

/** Turns `#123` and `owner/repo#123` in an mdast tree's text into issue links, in place. */
export function linkGitHubReferences(node: MarkdownNode, defaultRepo: GitHubRepoReference): void {
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
