import {
  getProjectIdentityKey,
  isGitHubBackedRepo
} from '../../../shared/project-host-setup-projection'
import type { Repo } from '../../../shared/types'

// Why: GitHub-CLI setup nudges are dismissible, but the dismissal must lapse
// when the user adds a NEW GitHub-backed project — that's the moment the CLI
// actually becomes useful. We snapshot the set of GitHub project identity keys
// present at dismiss time; a later set that contains a key not in the snapshot
// means a genuinely new GitHub project appeared and the nudge should return.

const STORAGE_PREFIX = 'orca.preflightBanner.dismissed.'

type DismissalRecord = {
  /** GitHub project identity keys present when the user dismissed. */
  githubKeys: string[]
}

function storageKey(issueId: string): string {
  return `${STORAGE_PREFIX}${issueId}`
}

/** GitHub-backed project identity keys for the current repo set, de-duped so
 *  the same GitHub project added twice doesn't read as two distinct projects. */
export function githubProjectKeys(repos: Repo[]): string[] {
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

/** True when the issue was dismissed and no new GitHub project has appeared
 *  since. A GitHub key present now but absent from the snapshot re-surfaces it. */
export function isPreflightIssueDismissed(issueId: string, repos: Repo[]): boolean {
  const record = readRecord(issueId)
  if (!record) {
    return false
  }
  const snapshot = new Set(record.githubKeys)
  const hasNewGithubProject = githubProjectKeys(repos).some((key) => !snapshot.has(key))
  return !hasNewGithubProject
}

export function dismissPreflightIssue(issueId: string, repos: Repo[]): void {
  try {
    const record: DismissalRecord = { githubKeys: githubProjectKeys(repos) }
    localStorage.setItem(storageKey(issueId), JSON.stringify(record))
  } catch {
    // Why: a blocked storage write shouldn't break dismiss for the session;
    // the in-memory state in PreflightBanner still hides it until relaunch.
  }
}
