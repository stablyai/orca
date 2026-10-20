import type { Repo } from './repo-types'

export type IncognitoLockState = {
  unlocked: boolean
  touchIdAvailable: boolean
  passcodeSet: boolean
  /** Opt-out of hiding Orca from screen capture while unlocked; main-owned, per machine. */
  allowScreenCapture: boolean
}

export type IncognitoUnlockResult =
  | { ok: true }
  | {
      ok: false
      reason:
        | 'cancelled'
        | 'unavailable'
        | 'wrong-passcode'
        | 'invalid-passcode'
        | 'locked'
        | 'rate-limited'
      retryAfterMs?: number
    }

/** Clients without an unlock (web, paired phones) see incognito projects as permanently locked. */
export const LOCKED_INCOGNITO_STATE: IncognitoLockState = {
  unlocked: false,
  touchIdAvailable: false,
  passcodeSet: false,
  allowScreenCapture: false
}

export const EMPTY_CONCEALED_REPO_IDS: ReadonlySet<string> = new Set()

export function isIncognitoRepo(repo: Pick<Repo, 'incognito'> | undefined | null): boolean {
  return repo?.incognito === true
}

/** Repo ids every list surface must drop while incognito projects are locked. */
export function getConcealedRepoIds(
  repos: readonly Pick<Repo, 'id' | 'incognito'>[],
  unlocked: boolean
): ReadonlySet<string> {
  if (unlocked) {
    return EMPTY_CONCEALED_REPO_IDS
  }
  let concealed: Set<string> | null = null
  for (const repo of repos) {
    if (isIncognitoRepo(repo)) {
      concealed ??= new Set()
      concealed.add(repo.id)
    }
  }
  return concealed ?? EMPTY_CONCEALED_REPO_IDS
}

export function withoutConcealedRepos<T extends Pick<Repo, 'id'>>(
  repos: readonly T[],
  concealedRepoIds: ReadonlySet<string>
): T[] {
  return concealedRepoIds.size === 0
    ? [...repos]
    : repos.filter((repo) => !concealedRepoIds.has(repo.id))
}

/** Remote clients (paired phones, web) have no unlock, so they always drop incognito projects. */
export function withoutIncognitoRepos<T extends Pick<Repo, 'incognito'>>(repos: readonly T[]): T[] {
  return repos.filter((repo) => !isIncognitoRepo(repo))
}
