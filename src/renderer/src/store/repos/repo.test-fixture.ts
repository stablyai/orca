import type { AppState } from '../types'

/** A repo stamped as owned by `environmentId`, the way ingest stamps fetched rows. */
export function runtimeOwnedRepoState(
  environmentId: string,
  id: string,
  path: string,
  extra: Partial<AppState> = {}
): Partial<AppState> {
  return {
    repos: [
      {
        id,
        path,
        displayName: 'repo',
        badgeColor: '',
        addedAt: 0,
        executionHostId: `runtime:${environmentId}`
      }
    ],
    ...extra
  }
}

export const TEST_REPO = {
  id: 'repo1',
  path: '/repo1',
  displayName: 'Repo 1',
  badgeColor: '#000',
  addedAt: 0
}
