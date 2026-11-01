import {
  getProjectIdentityKey,
  isGitHubBackedRepo
} from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/repo-types'

// Snapshot GitHub identities on dismissal; show the nudge again only when a new GitHub project appears.

const STORAGE_PREFIX = 'orca.preflightBanner.dismissed.'

type DismissalRecord = {
  githubKeys: string[]
}

function storageKey(issueId: string): string {
  return `${STORAGE_PREFIX}${issueId}`
}

/** Deduplicate project identities so registering the same GitHub repo twice does not count as a new project. */
export function githubProjectKeys(repos: readonly Repo[]): string[] {
  const keys = repos
    .filter((repo) => isGitHubBackedRepo(repo))
    .map((repo) => getProjectIdentityKey(repo))
  return [...new Set(keys)].sort()
}

function readRecord(issueId: string): DismissalRecord | null {
  try {
    const raw = localStorage.getItem(storageKey(issueId))
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as DismissalRecord
    return Array.isArray(parsed?.githubKeys) ? parsed : null
  } catch {
    return null
  }
}

/** Keep dismissed while every current GitHub identity was present in the dismissal snapshot. */
export function isPreflightIssueDismissed(issueId: string, repos: readonly Repo[]): boolean {
  const record = readRecord(issueId)
  if (!record) {
    return false
  }
  const snapshot = new Set(record.githubKeys)
  const hasNewGithubProject = githubProjectKeys(repos).some((key) => !snapshot.has(key))
  return !hasNewGithubProject
}

export function dismissPreflightIssue(issueId: string, repos: readonly Repo[]): void {
  try {
    const record: DismissalRecord = { githubKeys: githubProjectKeys(repos) }
    localStorage.setItem(storageKey(issueId), JSON.stringify(record))
  } catch {
    // Blocked storage must not break dismissal; the banner’s in-memory state lasts until relaunch.
  }
}
