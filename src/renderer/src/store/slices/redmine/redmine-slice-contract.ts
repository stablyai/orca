import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type {
  RedmineConnectionStatus,
  RedmineIssue,
  RedmineIssueCollectionResult,
  RedmineListFilter,
  RedmineReadError,
  RedmineSite,
  RedmineUser
} from '../../../../../shared/redmine-types'
import type { CacheEntry } from '../../github/cache-model'

export type RedmineFetchOptions = { force?: boolean }

export type RedmineFetchResult =
  | { ok: true; site: RedmineSite; viewer: RedmineUser }
  | { ok: false; error: { type: string; message: string } }

export type RedmineSlice = {
  redmineStatus: RedmineConnectionStatus
  redmineStatusChecked: boolean
  redmineStatusContextKey: string | null
  redmineIssueCache: Record<string, CacheEntry<RedmineIssue>>
  redmineListCache: Record<string, CacheEntry<RedmineIssueCollectionResult>>
  redmineListInvalidationToken: { scope: string; version: number }

  checkRedmineConnection: (force?: boolean) => Promise<void>
  connectRedmine: (args: { siteUrl: string; apiKey: string }) => Promise<RedmineFetchResult>
  testRedmineConnection: (args: {
    siteUrl: string
    apiKey: string
  }) => Promise<
    { ok: true; user: RedmineUser } | { ok: false; error: { type: string; message: string } }
  >
  disconnectRedmine: () => Promise<void>
  listRedmineIssues: (
    filter?: RedmineListFilter,
    options?: RedmineFetchOptions
  ) => Promise<RedmineIssueCollectionResult>
  getRedmineIssue: (
    issueId: number,
    options?: RedmineFetchOptions
  ) => Promise<{ issue: RedmineIssue | null; error?: RedmineReadError }>
  invalidateRedmineIssueLists: () => void
}

export type RedmineSliceStateCreator = StateCreator<AppState, [], [], RedmineSlice>
export type RedmineSliceSet = Parameters<RedmineSliceStateCreator>[0]
export type RedmineSliceGet = Parameters<RedmineSliceStateCreator>[1]
