import type { GitHubWorkItem } from '../../../shared/types'
import { getLinkedWorkItemSuggestedName } from '../../../shared/workspace-name'
import type { LinkedWorkItemSummary } from './new-workspace'
import { parseGitHubIssueOrPRLink } from './github-links'

export type SmartGitHubSubmitIntent =
  | {
      kind: 'link'
      owner: string
      repo: string
      number: number
      type: 'issue' | 'pr'
    }
  | {
      kind: 'hash-number'
      number: number
    }

export type SmartGitHubSubmitResolution = {
  workspaceName: string
  displayName: string
  linkedWorkItem: LinkedWorkItemSummary
  linkedIssueNumber: number | null
  linkedPR: number | null
}

export type SmartGitHubSubmitLookup = {
  repoId: string
  repoPath: string
  intent: SmartGitHubSubmitIntent
  workItem: (args: {
    repoPath: string
    repoId: string
    number: number
  }) => Promise<GitHubWorkItem | null>
  workItemByOwnerRepo: (args: {
    repoPath: string
    repoId: string
    owner: string
    repo: string
    number: number
    type: 'issue' | 'pr'
  }) => Promise<GitHubWorkItem | null>
}

const SMART_GITHUB_SUBMIT_LOOKUP_TTL_MS = 60_000
const SMART_GITHUB_SUBMIT_LOOKUP_CACHE_MAX_ENTRIES = 128

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

  const link = parseGitHubIssueOrPRLink(trimmed)
  if (link) {
    return {
      kind: 'link',
      owner: link.slug.owner,
      repo: link.slug.repo,
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

function getSmartGitHubSubmitLookupCacheKey({
  repoId,
  repoPath,
  intent
}: {
  repoId: string
  repoPath: string
  intent: SmartGitHubSubmitIntent
}): string {
  const repoScope = `${repoId}:${repoPath}`
  if (intent.kind === 'hash-number') {
    return `${repoScope}:hash:${intent.number}`
  }
  return `${repoScope}:link:${intent.owner.toLowerCase()}/${intent.repo.toLowerCase()}:${
    intent.type
  }:${intent.number}`
}

export function lookupSmartGitHubSubmitItem({
  repoId,
  repoPath,
  intent,
  workItem,
  workItemByOwnerRepo
}: SmartGitHubSubmitLookup): Promise<GitHubWorkItem | null> {
  const key = getSmartGitHubSubmitLookupCacheKey({ repoId, repoPath, intent })
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
          owner: intent.owner,
          repo: intent.repo,
          number: intent.number,
          type: intent.type
        })
      : workItem({
          repoPath,
          repoId,
          number: intent.number
        })
  const stampedPromise = promise.then((item) => (item ? { ...item, repoId } : null))
  smartGitHubSubmitLookupCache.set(key, {
    promise: stampedPromise,
    expiresAt: now + SMART_GITHUB_SUBMIT_LOOKUP_TTL_MS
  })
  pruneSmartGitHubSubmitLookupCache(now)
  // Why: transient GitHub/IPC failures should dedupe while in flight, but
  // must not poison immediate create retries for the full cache TTL.
  void stampedPromise.catch(() => {
    if (smartGitHubSubmitLookupCache.get(key)?.promise === stampedPromise) {
      smartGitHubSubmitLookupCache.delete(key)
    }
  })
  return stampedPromise
}

export function clearSmartGitHubSubmitLookupCacheForTests(): void {
  smartGitHubSubmitLookupCache.clear()
}

export function getSmartGitHubSubmitLookupCacheSizeForTests(): number {
  return smartGitHubSubmitLookupCache.size
}

export function getSmartGitHubSubmitResolution(
  item: Pick<GitHubWorkItem, 'number' | 'title' | 'type' | 'url'>
): SmartGitHubSubmitResolution {
  const fallbackName = `${item.type}-${item.number}`
  const workspaceName = getLinkedWorkItemSuggestedName(item) || fallbackName
  const linkedWorkItem: LinkedWorkItemSummary = {
    type: item.type,
    number: item.number,
    title: item.title,
    url: item.url
  }

  return {
    workspaceName,
    displayName: item.title,
    linkedWorkItem,
    linkedIssueNumber: item.type === 'issue' ? item.number : null,
    linkedPR: item.type === 'pr' ? item.number : null
  }
}
