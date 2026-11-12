import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import { parseLinearIssueUrl } from '../../../../../../shared/linear/linear-reference-links'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'

/** A Linear issue link: the organization in its URL, and the issue's identifier. */
export type LinearChatLink = { orgUrlKey: string; identifier: string }

const previews = createHoverPreviewCache<LinearIssue>({ freshMs: 60_000, maxEntries: 200 })

// Bumped on every account change, so keys from the last account never match again.
let generation = 0
const generationListeners = new Set<() => void>()

function subscribeToGeneration(listener: () => void): () => void {
  generationListeners.add(listener)
  return () => generationListeners.delete(listener)
}

/** Re-renders the caller when the Linear account changes, so its preview key moves on. */
export function useLinearPreviewGeneration(): number {
  return useSyncExternalStore(subscribeToGeneration, () => generation)
}

/** Cache key for a Linear preview; two organizations can both have an `ENG-1`. */
export function linearLinkPreviewKey(link: LinearChatLink): string {
  return `linear:${generation}:${link.orgUrlKey.toLowerCase()}:${link.identifier}`
}

/** Lets a reopened card or a re-rendered chip paint its last answer without a loading frame. */
export function readCachedLinearLinkPreview(link: LinearChatLink): LinearIssue | null {
  return previews.read(linearLinkPreviewKey(link))
}

/** True when the issue belongs to the organization the link names. */
export function linearIssueMatchesLink(issue: LinearIssue, link: LinearChatLink): boolean {
  const issueOrg = parseLinearIssueUrl(issue.url)?.orgUrlKey
  return issueOrg?.toLowerCase() === link.orgUrlKey.toLowerCase()
}

/** Reads through the store, which owns Linear's host routing and shares its issue cache with the Tasks page. */
async function fetchIssue(link: LinearChatLink): Promise<LinearIssue | null> {
  // 'all' asks every connected workspace; an issue from another organization counts as not found.
  const lease = useAppStore.getState().fetchLinearIssue(link.identifier, 'all').acquire()
  try {
    const view = await lease.waitForCurrentTerminal()
    if (view.kind === 'error') {
      throw view.error
    }
    return view.data && linearIssueMatchesLink(view.data, link) ? view.data : null
  } finally {
    lease.release()
  }
}

/** Drops every Linear preview; a different Linear account must not see the last one's issues. */
export function clearLinearLinkPreviews(): void {
  previews.clear()
  generation += 1
  for (const listener of generationListeners) {
    listener()
  }
}

/** Loads the issue a Linear link points to, or null when no connected workspace has it. */
export function loadLinearLinkPreview(link: LinearChatLink): Promise<LinearIssue | null> {
  return previews.load(linearLinkPreviewKey(link), () => fetchIssue(link))
}
