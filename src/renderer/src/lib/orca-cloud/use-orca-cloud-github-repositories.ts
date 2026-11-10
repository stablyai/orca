// Repositories Orca Cloud can reach on GitHub that have no clone on this computer (cloud-start D4,
// N12): the Project picker lists them under "On GitHub · Orca Cloud only" while Orca Cloud is
// picked, because a sandbox clones from GitHub anyway.
import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type { HostedGithubRepositoriesResponse } from '../../../../shared/hosted-sandbox/hosted-github-wire'
import { orcaCloudGitHubRepoUrl } from './use-orca-cloud-repo-access'

export type OrcaCloudGitHubRepository = {
  /** owner/name, as GitHub spells it. */
  fullName: string
  url: string
  private: boolean
}

/** Two pages cover nearly every team; the rest is a search away on GitHub's own page. */
const MAX_PAGES = 2
const CACHE_MS = 5 * 60_000

let cache: { at: number; value: Promise<OrcaCloudGitHubRepository[]> } | null = null

async function fetchAll(): Promise<OrcaCloudGitHubRepository[]> {
  const out: OrcaCloudGitHubRepository[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await window.api.orcaCloudWorkspace.listGitHubRepositories({ cursor })
    if (!result.ok) {
      break
    }
    const value: HostedGithubRepositoriesResponse = result.value
    for (const repo of value.repositories) {
      out.push({ fullName: repo.fullName, url: repo.url, private: repo.private })
    }
    cursor = value.nextCursor
    if (!cursor) {
      break
    }
  }
  return out
}

function loadRepositories(): Promise<OrcaCloudGitHubRepository[]> {
  const now = Date.now()
  if (!cache || now - cache.at >= CACHE_MS) {
    const entry = { at: now, value: fetchAll().catch(() => []) }
    cache = entry
  }
  return cache.value
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

export function useOrcaCloudGitHubRepositories(
  enabled: boolean
): OrcaCloudGitHubRepository[] | null {
  const repos = useAppStore((s) => s.repos)
  const [reachable, setReachable] = useState<OrcaCloudGitHubRepository[] | null>(null)
  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void loadRepositories().then((value) => {
      if (!cancelled) {
        setReachable(value)
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled])
  return useMemo(
    () =>
      enabled && reachable
        ? selectCloudOnlyRepositories(
            reachable,
            repos.map((repo) => orcaCloudGitHubRepoUrl(repo))
          )
        : null,
    [enabled, reachable, repos]
  )
}
