import { translate } from '@/i18n/i18n'
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
      // Forced callers must await weaker in-flight work then refetch, like fetchWorkItems.
      if (!options?.force || existing.force) {
        return existing.promise
      }
      // Wait only once for weaker work so peers share upgrades without starvation.
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
        // Bounded waits may overlap stronger requests; late non-OK results must not overwrite their newer data/errors.
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
        // Classify unexpected IPC failures into the same envelope so renderer handles one error shape.
        console.error('Failed to fetch GitHub project view:', err)
        return {
          ok: false,
          error: {
            type: 'unknown',
            message:
              err instanceof Error
                ? err.message
                : translate('projectViews.picker.viewFailed', 'Failed to fetch project view')
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
