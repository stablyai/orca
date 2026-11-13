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
let cache: { at: number; identity: string; value: Promise<Listing>; empty?: boolean } | null = null

/** The list couldn't be read (signed-in state settling after a restart, a role change, GitHub down). */
class RepositoriesUnavailable extends Error {}

async function fetchPages(after: Listing): Promise<Listing> {
  const repos = [...after.repos]
  let cursor = after.nextCursor
  for (let page = 0; page < PAGES_PER_LOAD; page += 1) {
    const result = await window.api.orcaCloudWorkspace.listGitHubRepositories({ cursor })
    if (!result.ok) {
      // GH-LIST-MISSING: a failed first page used to resolve as an empty list, cached for 5 min,
      // and an empty list hides the GitHub section: it looked like there were no repositories.
      if (page === 0) {
        throw new RepositoriesUnavailable(result.message ?? result.code)
      }
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

/** The listing, or 'unavailable' when GitHub's list couldn't be read (never cached). */
function loadRepositories(identity: string, more = false): Promise<Listing | 'unavailable'> {
  const now = Date.now()
  // Another account's or team's repositories are never this one's (sign-out, team switch). An
  // empty answer isn't kept either: each open asks again, in case access arrived meanwhile.
  if (
    !cache ||
    cache.identity !== identity ||
    now - cache.at >= CACHE_MS ||
    (!more && cache.empty)
  ) {
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
  return entry.value.then(
    (listing) => {
      entry.empty = listing.repos.length === 0
      return listing
    },
    () => {
      if (cache === entry) {
        cache = null
      }
      return 'unavailable' as const
    }
  )
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
  /** GitHub's list couldn't be read: the picker says so with Retry instead of hiding the section. */
  unavailable: boolean
  retry: () => void
} {
  const repos = useAppStore((s) => s.repos)
  const identity = useOrcaCloudIdentityKey()
  const [answer, setAnswer] = useState<{
    identity: string
    listing: Listing | 'unavailable'
  } | null>(null)
  const [moreRequests, setMoreRequests] = useState(0)
  const [retries, setRetries] = useState(0)
  const current = answer?.identity === identity ? answer.listing : null
  const listing = current === 'unavailable' ? null : current
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
  }, [enabled, identity, moreRequests, refreshSignal, retries])
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
  const retry = useCallback(() => setRetries((n) => n + 1), [])
  return {
    repos: visible,
    showMore: enabled && listing?.nextCursor ? showMore : null,
    unavailable: enabled && current === 'unavailable',
    retry
  }
}
