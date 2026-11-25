import type { GitHubWorkItem } from '../../../../../shared/github/work-items/work-item-types'
import type { GitPushTarget } from '../../../../../shared/worktree/types'
import {
  type TaskSourceContext,
  getTaskSourceCacheScope
} from '../../../../../shared/work-items/task-source-context'

import { getLinkedWorkItemWorkspaceName } from '../../../../../shared/workspace/naming/workspace-name'
import type { LinkedWorkItemSummary } from '../../workspace/creation/new-workspace'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/repositories/links'
import {
  githubIssueReferenceContext,
  resolveGitHubIssueReference
} from '../../../../../shared/github/repositories/github-issue-reference'
import { resolveGitHubWorkItemIdentity } from '../../../../../shared/new-workspace/github-work-item-identity'
import { githubRepoIdentityKey } from '../../../../../shared/github/repositories/repository-identity-key'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { resolveRepoSlug } from '@/lib/workspace/catalog/repo-slug-index'

export type SmartGitHubSubmitIntent =
  | {
      kind: 'link'
      owner: string
      repo: string
      host?: string
      number: number
      type: 'issue' | 'pr'
      allowSameHost?: boolean
    }
  | {
      kind: 'hash-number'
      number: number
      type?: 'pr'
    }

export type SmartGitHubSubmitResolution = {
  workspaceName: string
  displayName: string
  linkedWorkItem: LinkedWorkItemSummary
  linkedIssueNumber: number | null
  linkedPR: number | null
  baseBranch?: string
  compareBaseRef?: string
  pushTarget?: GitPushTarget
  branchNameOverride?: string
}

export type SmartGitHubSubmitLookup = {
  repoId: string
  repoPath: string
  sourceContext?: TaskSourceContext | null
  intent: SmartGitHubSubmitIntent
  workItem: (args: {
    repoPath: string
    repoId: string
    sourceContext?: TaskSourceContext | null
    number: number
    type?: 'pr'
  }) => Promise<GitHubWorkItem | null>
  workItemByOwnerRepo: (args: {
    repoPath: string
    repoId: string
    sourceContext?: TaskSourceContext | null
    owner: string
    repo: string
    host?: string
    number: number
    type: 'issue' | 'pr'
    allowSameHost?: boolean
  }) => Promise<GitHubWorkItem | null>
}

const SMART_GITHUB_SUBMIT_LOOKUP_TTL_MS = 60_000
const SMART_GITHUB_SUBMIT_LOOKUP_CACHE_MAX_ENTRIES = 128
const GITHUB_ITEM_URL_RE = /https?:\/\/[^\s/]+\/\S+/i
const TRAILING_GITHUB_ITEM_URL_PUNCTUATION_RE = /[),.;\]}]+$/

type SmartGitHubSubmitLookupCacheEntry = {
  expiresAt: number
  promise: Promise<GitHubWorkItem | null>
}

const smartGitHubSubmitLookupCache = new Map<string, SmartGitHubSubmitLookupCacheEntry>()

function pruneSmartGitHubSubmitLookupCache(now: number): void {
  for (const [key, entry] of smartGitHubSubmitLookupCache) {
    if (entry.expiresAt <= now) {
      smartGitHubSubmitLookupCache.delete(key)
    }
  }
  while (smartGitHubSubmitLookupCache.size > SMART_GITHUB_SUBMIT_LOOKUP_CACHE_MAX_ENTRIES) {
    const oldestKey = smartGitHubSubmitLookupCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    smartGitHubSubmitLookupCache.delete(oldestKey)
  }
}

export function getSmartGitHubSubmitIntent(input: string): SmartGitHubSubmitIntent | null {
  const trimmed = input.trim()
  if (!trimmed) {
    return null
  }

  const link = parseGitHubIssueOrPRLink(trimmed) ?? parseGitHubIssueOrPRLinkFromText(trimmed)
  if (link) {
    return {
      kind: 'link',
      owner: link.slug.owner,
      repo: link.slug.repo,
      ...(link.slug.host ? { host: link.slug.host } : {}),
      number: link.number,
      type: link.type
    }
  }

  if (/^#\d+$/.test(trimmed)) {
    return {
      kind: 'hash-number',
      number: Number.parseInt(trimmed.slice(1), 10)
    }
  }

  return null
}

function parseGitHubIssueOrPRLinkFromText(
  input: string
): ReturnType<typeof parseGitHubIssueOrPRLink> {
  const match = GITHUB_ITEM_URL_RE.exec(input)
  return match
    ? parseGitHubIssueOrPRLink(match[0].replace(TRAILING_GITHUB_ITEM_URL_PUNCTUATION_RE, ''))
    : null
}

function getSmartGitHubSubmitLookupCacheKey({
  repoId,
  repoPath,
  sourceContext,
  intent
}: {
  repoId: string
  repoPath: string
  sourceContext?: TaskSourceContext | null
  intent: SmartGitHubSubmitIntent
}): string {
  const sourceScope = sourceContext ? getTaskSourceCacheScope(sourceContext) : 'default'
  const repoScope = `${sourceScope}:${repoId}:${repoPath}`
  if (intent.kind === 'hash-number') {
    return `${repoScope}:hash:${intent.number}:${intent.type ?? 'any'}`
  }
  return `${repoScope}:link:${githubRepoIdentityKey(intent)}:${intent.type}:${intent.number}:${intent.allowSameHost === true}`
}

export function lookupSmartGitHubSubmitItem({
  repoId,
  repoPath,
  sourceContext,
  intent,
  workItem,
  workItemByOwnerRepo
}: SmartGitHubSubmitLookup): Promise<GitHubWorkItem | null> {
  const key = getSmartGitHubSubmitLookupCacheKey({ repoId, repoPath, sourceContext, intent })
  const now = Date.now()
  pruneSmartGitHubSubmitLookupCache(now)
  const cached = smartGitHubSubmitLookupCache.get(key)
  if (cached && cached.expiresAt > now) {
    return cached.promise
  }

  const promise =
    intent.kind === 'link'
      ? workItemByOwnerRepo({
          repoPath,
          repoId,
          sourceContext,
          owner: intent.owner,
          repo: intent.repo,
          ...(intent.host ? { host: intent.host } : {}),
          number: intent.number,
          type: intent.type,
          ...(intent.allowSameHost ? { allowSameHost: true } : {})
        })
      : workItem({
          repoPath,
          repoId,
          sourceContext,
          number: intent.number,
          ...(intent.type ? { type: intent.type } : {})
        })
  const stampedPromise = promise.then((item) => (item ? { ...item, repoId } : null))
  smartGitHubSubmitLookupCache.set(key, {
    promise: stampedPromise,
    expiresAt: now + SMART_GITHUB_SUBMIT_LOOKUP_TTL_MS
  })
  pruneSmartGitHubSubmitLookupCache(now)
  // Deduplicate transient failures only in flight; do not poison immediate retries for the cache TTL.
  void stampedPromise.catch(() => {
    if (smartGitHubSubmitLookupCache.get(key)?.promise === stampedPromise) {
      smartGitHubSubmitLookupCache.delete(key)
    }
  })
  return stampedPromise
}

type SmartGitHubNumberLookup = Omit<SmartGitHubSubmitLookup, 'repoId' | 'repoPath' | 'intent'>

function bareNumberLookups(repo: Repo, number: number, lookup: SmartGitHubNumberLookup) {
  const lookupIntent = (intent: SmartGitHubSubmitIntent) =>
    lookupSmartGitHubSubmitItem({ ...lookup, repoId: repo.id, repoPath: repo.path, intent }).catch(
      () => null
    )
  const { defaultGitHubIssueRepository } = repo
  if (!defaultGitHubIssueRepository) {
    return { any: () => lookupIntent({ kind: 'hash-number', number }), issue: null, pr: null }
  }
  return {
    any: null,
    issue: async (): Promise<GitHubWorkItem | null> => {
      const issue = resolveGitHubIssueReference(
        { kind: 'bare', number },
        githubIssueReferenceContext(repo, await resolveRepoSlug(repo))
      )
      return issue?.kind === 'url'
        ? lookupIntent({
            kind: 'link',
            owner: issue.owner,
            repo: issue.repo,
            host: issue.host,
            number: issue.number,
            type: 'issue',
            allowSameHost: true
          })
        : null
    },
    pr: () => lookupIntent({ kind: 'hash-number', number, type: 'pr' })
  }
}

/** Candidates for bare `#N`: the default issue repository's issue and the project's PR. */
export async function lookupSmartGitHubNumberItems(
  repo: Repo,
  number: number,
  lookup: SmartGitHubNumberLookup
): Promise<GitHubWorkItem[]> {
  const { any, issue, pr } = bareNumberLookups(repo, number, lookup)
  const items = await Promise.all(any ? [any()] : [issue(), pr()])
  return items.filter((item) => item !== null)
}

/** The item bare `#N` submits to; the default issue repository's issue wins over the project's PR. */
export async function lookupSmartGitHubNumberItem(
  repo: Repo,
  number: number,
  lookup: SmartGitHubNumberLookup
): Promise<GitHubWorkItem | null> {
  const { any, issue, pr } = bareNumberLookups(repo, number, lookup)
  return any ? any() : ((await issue()) ?? pr())
}

export function getSmartGitHubSubmitResolution(
  item: Pick<GitHubWorkItem, 'number' | 'title' | 'type' | 'url'>
): SmartGitHubSubmitResolution {
  const identity = resolveGitHubWorkItemIdentity(item)
  const normalizedItem = { ...item, type: identity.type, number: identity.number }
  const fallbackName = `${identity.type}-${identity.number}`
  const titleName = getLinkedWorkItemWorkspaceName(normalizedItem)
  const workspaceName = titleName?.seedName || fallbackName
  const linkedWorkItem: LinkedWorkItemSummary = {
    type: identity.type,
    number: identity.number,
    title: item.title,
    url: item.url
  }

  return {
    workspaceName,
    displayName: titleName?.displayName ?? fallbackName,
    linkedWorkItem,
    linkedIssueNumber: identity.type === 'issue' ? identity.number : null,
    linkedPR: identity.type === 'pr' ? identity.number : null
  }
}
