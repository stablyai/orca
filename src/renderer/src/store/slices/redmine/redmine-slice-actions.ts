import {
  redmineConnect,
  redmineDisconnect,
  redmineGetIssue,
  redmineListIssues,
  redmineStatus,
  redmineTestConnection
} from '@/runtime/runtime-redmine-client'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  isFresh,
  redmineIssueCacheKey,
  redmineListCacheKey,
  redmineListInvalidationToken,
  redmineStatusScopeSignature,
  setRedmineListInvalidationToken
} from './redmine-cache'
import type {
  RedmineFetchResult,
  RedmineSlice,
  RedmineSliceGet,
  RedmineSliceSet
} from './redmine-slice-contract'

// Why: a module counter lets a superseded connect/status probe avoid clobbering
// the fresh result of a newer request. Mirrors the Linear slice's generation
// guard without the per-slice request-state machinery.
let requestGeneration = 0
function beginRequest(): number {
  requestGeneration += 1
  return requestGeneration
}

function emptyStatus() {
  return { connected: false, activeSite: null, selectedSiteId: null, viewer: null, error: null }
}

export function createRedmineActions(
  set: RedmineSliceSet,
  get: RedmineSliceGet
): Pick<
  RedmineSlice,
  | 'checkRedmineConnection'
  | 'connectRedmine'
  | 'testRedmineConnection'
  | 'disconnectRedmine'
  | 'listRedmineIssues'
  | 'getRedmineIssue'
  | 'invalidateRedmineIssueLists'
> {
  return {
    checkRedmineConnection: async (force) => {
      if (!force && get().redmineStatusChecked) {
        return
      }
      const generation = beginRequest()
      const status = await redmineStatus(get().settings)
      if (generation !== requestGeneration) {
        return
      }
      const prev = get().redmineStatus
      if (redmineStatusScopeSignature(prev) !== redmineStatusScopeSignature(status)) {
        set({
          redmineStatus: status,
          redmineIssueCache: {},
          redmineListCache: {},
          redmineStatusChecked: true,
          redmineStatusContextKey: getProviderRuntimeContextKey(get().settings)
        })
      } else {
        set({ redmineStatusChecked: true })
      }
    },

    connectRedmine: async ({ siteUrl, apiKey }) => {
      const generation = beginRequest()
      const contextKey = getProviderRuntimeContextKey(get().settings)
      const result = await redmineConnect(get().settings, { siteUrl, apiKey })
      if (result.ok && generation === requestGeneration) {
        const status = await redmineStatus(get().settings)
        if (generation === requestGeneration) {
          set({
            redmineStatus: status,
            redmineStatusChecked: true,
            redmineStatusContextKey: getProviderRuntimeContextKey(get().settings),
            redmineIssueCache: {},
            redmineListCache: {}
          })
        }
      }
      if (result.ok && getProviderRuntimeContextKey(get().settings) !== contextKey) {
        return {
          ok: false as const,
          error: { type: 'unknown', message: 'Connection superseded by a newer request.' }
        }
      }
      return result as RedmineFetchResult
    },

    testRedmineConnection: async ({ siteUrl, apiKey }) => {
      return redmineTestConnection(get().settings, { siteUrl, apiKey })
    },

    disconnectRedmine: async () => {
      const generation = beginRequest()
      await redmineDisconnect(get().settings, get().redmineStatus.activeSite?.id)
      if (generation !== requestGeneration) {
        return
      }
      set({
        redmineStatus: emptyStatus(),
        redmineStatusChecked: true,
        redmineIssueCache: {},
        redmineListCache: {}
      })
    },

    listRedmineIssues: async (filter, options) => {
      const generation = beginRequest()
      const key = `${redmineListInvalidationToken.scope}:${redmineListCacheKey(filter)}`
      const cached = get().redmineListCache[key]
      if (!options?.force && cached?.data && isFresh(cached)) {
        return cached.data
      }
      const result = await redmineListIssues(get().settings, filter)
      await get().checkRedmineConnection()
      if (generation === requestGeneration) {
        set((state) => ({
          redmineListCache: {
            ...state.redmineListCache,
            [key]: { data: result, fetchedAt: Date.now() }
          }
        }))
      }
      return result
    },

    getRedmineIssue: async (issueId, options) => {
      const generation = beginRequest()
      const key = redmineIssueCacheKey(issueId)
      const cached = get().redmineIssueCache[key]
      if (!options?.force && cached?.data && isFresh(cached)) {
        return { issue: cached.data }
      }
      const result = await redmineGetIssue(get().settings, issueId)
      if (result.issue && generation === requestGeneration) {
        set((state) => ({
          redmineIssueCache: {
            ...state.redmineIssueCache,
            [key]: { data: result.issue, fetchedAt: Date.now() }
          }
        }))
      }
      return result
    },

    invalidateRedmineIssueLists: () => {
      const version = (redmineListInvalidationToken.version + 1) % 10_000
      setRedmineListInvalidationToken({ scope: String(version), version })
      set({
        redmineListInvalidationToken: { scope: String(version), version },
        redmineListCache: {}
      })
    }
  }
}
