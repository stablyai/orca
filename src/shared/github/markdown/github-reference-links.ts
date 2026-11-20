import type { Repo } from '../../repository/repo-types'
import {
  githubHostFromIdentityKey,
  repoUpstreamIdentityKey
} from '../repositories/repository-identity-key'

export type GitHubRepoReference = {
  owner: string
  repo: string
}

type MarkdownNode = {
  type: string
  value?: string
  url?: string
  title?: string | null
  data?: unknown
  children?: MarkdownNode[]
}

const GITHUB_REFERENCE_PATTERN = /(?:\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+))?#([1-9][0-9]*)\b/g

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

const REFERENCE_PREFIX_CHAR = /[A-Za-z0-9_./-]/
const REPO_NAME_CHAR = /[A-Za-z0-9_.-]/

function isEmbeddedGitHubReference(value: string, index: number): boolean {
  if (index === 0) {
    return false
  }
  return REFERENCE_PREFIX_CHAR.test(value[index - 1] ?? '')
}

function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

/** The one known repo called `name`; on a tie, the one owned by the default repo's owner. */
function repoNamed(
  name: string,
  defaultRepo: GitHubRepoReference | null,
  projectRepos: readonly GitHubRepoReference[]
): GitHubRepoReference | null {
  const known = defaultRepo ? [defaultRepo, ...projectRepos] : projectRepos
  const matches = known.filter(
    (candidate, i, all) =>
      sameName(candidate.repo, name) &&
      all.findIndex(
        (other) => sameName(other.owner, candidate.owner) && sameName(other.repo, candidate.repo)
      ) === i
  )
  if (matches.length === 1) {
    return matches[0]
  }
  if (!defaultRepo) {
    return null
  }
  const sameOwner = matches.filter((candidate) => sameName(candidate.owner, defaultRepo.owner))
  return sameOwner.length === 1 ? sameOwner[0] : null
}

/** `name#123` written right before a bare match: where `name` starts, or -1 when it is not one. */
function repoNameStart(value: string, hashIndex: number, cursor: number): number {
  let start = hashIndex
  while (start > cursor && REPO_NAME_CHAR.test(value[start - 1] ?? '')) {
    start -= 1
  }
  if (start === hashIndex || (start > 0 && REFERENCE_PREFIX_CHAR.test(value[start - 1] ?? ''))) {
    return -1
  }
  return start
}

function splitGitHubReferenceText(
  value: string,
  defaultRepo: GitHubRepoReference | null,
  projectRepos: readonly GitHubRepoReference[]
): MarkdownNode[] {
  const parts: MarkdownNode[] = []
  let cursor = 0

  for (const match of value.matchAll(GITHUB_REFERENCE_PATTERN)) {
    let index = match.index ?? 0
    const number = match[3]
    if (!number) {
      continue
    }
    // `#123` and `owner/repo#123` only link in a chat whose own repo is on github.com.
    let target: GitHubRepoReference | null =
      defaultRepo && match[1] && match[2] ? { owner: match[1], repo: match[2] } : defaultRepo
    if (isEmbeddedGitHubReference(value, index)) {
      const nameStart = match[1] ? -1 : repoNameStart(value, index, cursor)
      target =
        nameStart < 0 ? null : repoNamed(value.slice(nameStart, index), defaultRepo, projectRepos)
      index = nameStart
    }
    if (!target) {
      continue
    }
    const end = (match.index ?? 0) + match[0].length

    if (index > cursor) {
      parts.push({ type: 'text', value: value.slice(cursor, index) })
    }
    parts.push({
      type: 'link',
      url: createGitHubIssueUrl(target.owner, target.repo, number),
      title: null,
      children: [{ type: 'text', value: value.slice(index, end) }]
    })
    cursor = end
  }

  if (cursor === 0) {
    return [{ type: 'text', value }]
  }
  if (cursor < value.length) {
    parts.push({ type: 'text', value: value.slice(cursor) })
  }
  return parts
}

/** Turns `#123`, `owner/repo#123` and `name#123` in an mdast tree's text into issue links, in
 *  place. The first two need `defaultRepo`; `name#123` links when `name` is the repo of exactly
 *  one of `defaultRepo` and `projectRepos`. */
export function linkGitHubReferences(
  node: MarkdownNode,
  defaultRepo: GitHubRepoReference | null,
  projectRepos: readonly GitHubRepoReference[] = []
): void {
  if (!node.children || node.type === 'link' || node.type === 'image') {
    return
  }

  const nextChildren: MarkdownNode[] = []
  for (const child of node.children) {
    // Text an earlier pass drew as something else, such as a mention chip, stays as drawn.
    if (child.type === 'text' && child.value !== undefined && child.data === undefined) {
      // Agent replies can contain thousands of issue refs; append iteratively to avoid V8’s argument limit.
      for (const part of splitGitHubReferenceText(child.value, defaultRepo, projectRepos)) {
        nextChildren.push(part)
      }
    } else {
      linkGitHubReferences(child, defaultRepo, projectRepos)
      nextChildren.push(child)
    }
  }

  node.children = nextChildren
}
