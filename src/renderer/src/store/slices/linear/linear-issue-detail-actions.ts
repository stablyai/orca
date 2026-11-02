import type { LinearIssue } from '../../../../../shared/linear/issue-types'
import type { LinearSlice, LinearSliceGet, LinearSliceSet } from './linear-slice-contract'
import {
  credentialDecryptionMessage,
  isIntegrationCredentialDecryptionError
} from '../../../../../shared/integration-credential-errors'
import { linearGetIssue } from '@/runtime/runtime-linear-issue-mutations'
import { inflightIssueRequests } from './linear-slice-request-state'
import {
  getLinearReadScope,
  scopedLinearCacheKey,
  canPublishLinearScopeCache
} from './linear-slice-scope'
import { evictStaleEntries } from './linear-cache'
import { openStoreLinearIssueRead } from './linear-issue-read-actions'
import { mapLinearIssueRead, invalidateLinearIssueReads } from './linear-issue-publication'

export function createLinearIssueDetailActions(
  set: LinearSliceSet,
  get: LinearSliceGet
): Pick<LinearSlice, 'fetchLinearIssue' | 'refreshLinearIssue'> {
  return {
    fetchLinearIssue: (id, workspaceId, options) => {
      const scope = options?.scope ?? getLinearReadScope(get().settings, options?.sourceContext)
      const key = scopedLinearCacheKey(scope, `${workspaceId ?? 'selected'}::${id}`)
      const cached =
        get().linearIssueCache[key] ??
        (scope.explicitSource ? undefined : get().linearIssueCache[id])
      const read = openStoreLinearIssueRead<LinearIssue | null>({
        set,
        scope,
        key,
        workspaceId,
        identifier: id,
        get,
        force: options?.force,
        requests: inflightIssueRequests,
        cached,
        seed: options?.seed,
        dispatch: () =>
          linearGetIssue(scope.settings, id, workspaceId).catch((error: unknown) => {
            console.warn('[linear] fetchLinearIssue failed:', error)
            if (isIntegrationCredentialDecryptionError(error)) {
              throw new Error(credentialDecryptionMessage('Linear'))
            }
            throw error
          }),
        publish: (data) =>
          set((state) => ({
            linearIssueCache: evictStaleEntries({
              ...state.linearIssueCache,
              [key]: { data, fetchedAt: Date.now() }
            })
          }))
      })
      return options?.rejectCredentialError
        ? read
        : mapLinearIssueRead(
            read,
            (data) => data,
            () => null
          )
    },
    refreshLinearIssue: (id, workspaceId, options) => {
      const scope = options?.scope ?? getLinearReadScope(get().settings, options?.sourceContext)
      if (canPublishLinearScopeCache(scope, get().settings)) {
        const matches = (key: string) =>
          scope.cachePrefix ? key.startsWith(`${scope.cachePrefix}::`) : !key.startsWith('linear:')
        const retain = <T>(cache: Record<string, T>) =>
          Object.fromEntries(Object.entries(cache).filter(([key]) => !matches(key)))
        set((state) => ({
          linearIssueCache: Object.fromEntries(
            Object.entries(state.linearIssueCache).filter(
              ([key, entry]) =>
                !matches(key) || !(entry.data?.id === id || entry.data?.identifier === id)
            )
          ),
          linearSearchCache: retain(state.linearSearchCache),
          linearListCache: retain(state.linearListCache),
          linearProjectIssueCache: retain(state.linearProjectIssueCache),
          linearCustomViewIssueCache: retain(state.linearCustomViewIssueCache)
        }))
      }
      invalidateLinearIssueReads(scope, id, false, workspaceId)
      return get().fetchLinearIssue(id, workspaceId, { ...options, scope, force: true })
    }
  }
}
