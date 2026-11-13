// Repositories Orca Cloud can reach on GitHub that have no clone on this computer (cloud-start D4,
// N12): the Project picker lists them under "On GitHub · Orca Cloud only" while Orca Cloud is
// picked, because a sandbox clones from GitHub anyway.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { HostedGithubRepositoriesResponse } from '../../../../shared/hosted-sandbox/hosted-github-wire'
import { orcaCloudGitHubRepoUrl } from './use-orca-cloud-repo-access'
import { useOrcaCloudIdentityKey } from './orca-cloud-identity'

export type OrcaCloudGitHubRepository = {
  /** owner/name, as GitHub spells it. */
  fullName: string
  url: string
  private: boolean
}

/** Two pages at a time cover nearly every team; "Show more repositories…" fetches the next two. */
const PAGES_PER_LOAD = 2
const CACHE_MS = 5 * 60_000

type Listing = { repos: OrcaCloudGitHubRepository[]; nextCursor: string | null }

/** One listing at a time, for the identity (account and team) that asked for it. */
let cache: { at: number; identity: string; value: Promise<Listing> } | null = null

async function fetchPages(after: Listing): Promise<Listing> {
  const repos = [...after.repos]
  let cursor = after.nextCursor
  for (let page = 0; page < PAGES_PER_LOAD; page += 1) {
    const result = await window.api.orcaCloudWorkspace.listGitHubRepositories({ cursor })
    if (!result.ok) {
      break
    }
    const value: HostedGithubRepositoriesResponse = result.value
    for (const repo of value.repositories) {
      repos.push({ fullName: repo.fullName, url: repo.url, private: repo.private })
    }
    cursor = value.nextCursor
    if (!cursor) {
      break
    }
  }
  return { repos, nextCursor: cursor }
}

function loadRepositories(identity: string, more = false): Promise<Listing> {
  const now = Date.now()
  // Another account's or team's repositories are never this one's (sign-out, team switch).
  if (!cache || cache.identity !== identity || now - cache.at >= CACHE_MS) {
    cache = { at: now, identity, value: fetchPages({ repos: [], nextCursor: null }) }
  } else if (more) {
    const previous = cache.value
    cache = {
      at: cache.at,
      identity,
      value: previous.then((listing) => (listing.nextCursor ? fetchPages(listing) : listing))
    }
  }
  const entry = cache
  // A failed read isn't cached: the next open asks again.
  return entry.value.catch(() => {
    if (cache === entry) {
      cache = null
    }
    return { repos: [], nextCursor: null }
  })
}

/** Forget the list after the user gives Orca Cloud access to more repositories. */
export function invalidateOrcaCloudGitHubRepositories(): void {
  cache = null
}

/** owner/name in lower case, for matching a local clone's remote to GitHub's spelling. */
export function githubFullNameKey(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url)
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null
}

/** Repositories reachable on GitHub minus those already cloned here, sorted by name. */
export function selectCloudOnlyRepositories(
  reachable: readonly OrcaCloudGitHubRepository[],
  localRepoUrls: readonly (string | null)[]
): OrcaCloudGitHubRepository[] {
  const local = new Set(
    localRepoUrls.flatMap((url) => {
      const key = url ? githubFullNameKey(url) : null
      return key ? [key] : []
    })
  )
  return reachable
    .filter((repo) => !local.has(repo.fullName.toLowerCase()))
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
}

/** `refreshSignal`: each change reads the list again (after the cache was invalidated). */
export function useOrcaCloudGitHubRepositories(
  enabled: boolean,
  refreshSignal = 0
): {
  repos: OrcaCloudGitHubRepository[] | null
  /** Present while GitHub has more pages than are listed. */
  showMore: (() => void) | null
} {
  const repos = useAppStore((s) => s.repos)
  const identity = useOrcaCloudIdentityKey()
  const [answer, setAnswer] = useState<{ identity: string; listing: Listing } | null>(null)
  const [moreRequests, setMoreRequests] = useState(0)
  const listing = answer?.identity === identity ? answer.listing : null
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void loadRepositories(identity, moreRequests > 0).then((value) => {
      if (!cancelled) {
        setAnswer({ identity, listing: value })
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled, identity, moreRequests, refreshSignal])
  const visible = useMemo(
    () =>
      enabled && listing
        ? selectCloudOnlyRepositories(
            listing.repos,
            repos.map((repo) => orcaCloudGitHubRepoUrl(repo))
          )
        : null,
    [enabled, listing, repos]
  )
  const showMore = useCallback(() => setMoreRequests((n) => n + 1), [])
  return { repos: visible, showMore: enabled && listing?.nextCursor ? showMore : null }
}
