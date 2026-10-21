import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { GetProjectViewTableResult } from '../../../../shared/github/project-result-types'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import {
  projectViewCacheKey,
  projectViewRequestKey,
  projectViewSourceScope
} from './cache-identity'
import { withBoundedCacheEntry, WORK_ITEMS_CACHE_TTL } from './cache-policy'
import {
  acquireProviderRequestSlot as acquireWorkItemSlot,
  inflightProjectViewRequests,
  nextProviderRequestId,
  ownsInflightRequest,
  releaseProviderRequestSlot as releaseWorkItemSlot
} from './request-coordination'
import { createProjectFieldActions } from './project-field-mutations'

export const createProjectActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<
  GitHubSlice,
  'fetchProjectViewTable' | 'updateProjectFieldValue' | 'clearProjectFieldValue'
> => ({
  fetchProjectViewTable: async (target, args, options) => {
    const sourceScope = projectViewSourceScope(target)
    const requestKey = projectViewRequestKey(args, sourceScope)

    // Fast path: a caller-supplied `viewId` gives the resolved cache key up front, so serve a fresh entry directly.
    const maybeKnownKey = args.viewId
      ? projectViewCacheKey(
          args.ownerType,
          args.owner,
          args.projectNumber,
          args.viewId,
          args.queryOverride,
          sourceScope,
          args.host
        )
      : null
    if (!options?.force && maybeKnownKey) {
      const cached = get().projectViewCache[maybeKnownKey]
      if (cached?.data && Date.now() - cached.fetchedAt < WORK_ITEMS_CACHE_TTL) {
        return { ok: true, data: cached.data }
      }
    }

    let waitedForUpgrade = false
    for (;;) {
      const existing = inflightProjectViewRequests.get(requestKey)
      if (!existing) {
        break
      }
      // Why: a forcing caller must not dedupe to a non-forcing in-flight request; wait for it to settle, then issue a fresh forced call (mirrors fetchWorkItems).
      if (!options?.force || existing.force) {
        return existing.promise
      }
      // Why: wait out one weaker request so peers can share the upgrade, but never twice — a steady stream of weaker callers would otherwise starve this one forever.
      if (waitedForUpgrade) {
        break
      }
      waitedForUpgrade = true
      await existing.promise.catch(() => {})
    }

    const requestId = nextProviderRequestId()
    const request = (async (): Promise<GetProjectViewTableResult> => {
      await acquireWorkItemSlot()
      try {
        const envelope =
          target.kind === 'environment'
            ? await callRuntimeRpc<GetProjectViewTableResult>(
                target,
                'github.project.viewTable',
                args,
                { timeoutMs: 60_000 }
              )
            : await window.api.gh.getProjectViewTable(args)
        // Why: the bounded upgrade wait can leave us running beside a stronger request for this
        // key, so neither write below may land once it owns the key — a late non-OK reply would
        // otherwise stamp its error over the fresher table (or over a newer error) at the known key.
        if (!ownsInflightRequest(inflightProjectViewRequests, requestKey, requestId)) {
          return envelope
        }
        if (envelope.ok) {
          const table = envelope.data
          const key = projectViewCacheKey(
            table.project.ownerType,
            table.project.owner,
            table.project.number,
            table.selectedView.id,
            args.queryOverride,
            sourceScope,
            table.project.host
          )
          set((s) => ({
            projectViewCache: withBoundedCacheEntry(s.projectViewCache, key, {
              data: table,
              fetchedAt: Date.now()
            })
          }))
        } else if (maybeKnownKey) {
          // Why: only stamp the error when we have a resolved key; without one there's nowhere to write it and the renderer classifies from the envelope.
          set((s) => ({
            projectViewCache: withBoundedCacheEntry(s.projectViewCache, maybeKnownKey, {
              data: s.projectViewCache[maybeKnownKey]?.data ?? null,
              fetchedAt: Date.now(),
              error: envelope.error
            })
          }))
        }
        return envelope
      } catch (err) {
        // Why: the IPC boundary must not throw across the promise — wrap unexpected errors in the classified envelope for a single renderer shape.
        console.error('Failed to fetch GitHub project view:', err)
        return {
          ok: false,
          error: {
            type: 'unknown',
            message: err instanceof Error ? err.message : 'Failed to fetch project view'
          }
        }
      } finally {
        releaseWorkItemSlot()
      }
    })().finally(() => {
      if (ownsInflightRequest(inflightProjectViewRequests, requestKey, requestId)) {
        inflightProjectViewRequests.delete(requestKey)
      }
    })

    inflightProjectViewRequests.set(requestKey, {
      promise: request,
      requestId,
      force: Boolean(options?.force)
    })
    return request
  },

  ...createProjectFieldActions(set, get)
})
