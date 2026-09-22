import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { GitHubSlice } from './slice-types'
import type { GitHubProjectRow } from '../../../../shared/github/project-types'
import { translate } from '@/i18n/i18n'
import type {
  GetProjectViewTableResult,
  GitHubProjectMutationResult
} from '../../../../shared/github/project-result-types'
import { callRuntimeRpc, getActiveRuntimeTarget } from '../../runtime/runtime-rpc-client'
import {
  projectViewCacheKey,
  projectViewRequestKey,
  projectViewSourceScope,
  settingsForProjectViewCacheKey
} from './cache-identity'
import { withBoundedCacheEntry, WORK_ITEMS_CACHE_TTL } from './cache-policy'
import {
  acquireProviderRequestSlot as acquireWorkItemSlot,
  inflightProjectViewRequests,
  releaseProviderRequestSlot as releaseWorkItemSlot
} from './request-coordination'
import {
  applyRowPatch,
  optimisticFieldValueFromMutation,
  rollbackRowIfPresent
} from './project-cache'

export const createProjectActions = (
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): Pick<
  GitHubSlice,
  'fetchProjectViewTable' | 'updateProjectFieldValue' | 'clearProjectFieldValue'
> => ({
  fetchProjectViewTable: async (args, options) => {
    const target = getActiveRuntimeTarget(get().settings)
    const sourceScope = projectViewSourceScope(get().settings)
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

    const existing = inflightProjectViewRequests.get(requestKey)
    if (existing) {
      // Why: a forcing caller must not dedupe to a non-forcing in-flight request; wait for it to settle, then issue a fresh forced call (mirrors fetchWorkItems).
      if (options?.force && !existing.force) {
        await existing.promise.catch(() => {})
      } else {
        return existing.promise
      }
    }

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
        inflightProjectViewRequests.delete(requestKey)
      }
    })()

    inflightProjectViewRequests.set(requestKey, {
      promise: request,
      force: Boolean(options?.force)
    })
    return request
  },

  updateProjectFieldValue: async (cacheKey, rowId, fieldId, value) => {
    const state = get()
    const entry = state.projectViewCache[cacheKey]
    const table = entry?.data
    if (!table) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.a967f23983', 'Project view not loaded')
        }
      }
    }
    const rowIndex = table.rows.findIndex((r) => r.id === rowId)
    if (rowIndex === -1) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.f963485d37', 'Row not found')
        }
      }
    }
    const previousRow = table.rows[rowIndex]
    // Optimistic patch: build a field value matching the mutation shape.
    const nextField = optimisticFieldValueFromMutation(table, fieldId, value)
    const optimisticFieldValues = { ...previousRow.fieldValuesByFieldId }
    if (nextField) {
      optimisticFieldValues[fieldId] = nextField
    }
    const optimisticRow: GitHubProjectRow = {
      ...previousRow,
      fieldValuesByFieldId: optimisticFieldValues
    }
    applyRowPatch(set, cacheKey, rowId, optimisticRow)

    const target = getActiveRuntimeTarget(settingsForProjectViewCacheKey(get().settings, cacheKey))
    const result =
      target.kind === 'environment'
        ? await callRuntimeRpc<GitHubProjectMutationResult>(
            target,
            'github.project.updateItemField',
            {
              projectId: table.project.id,
              host: table.project.host,
              itemId: rowId,
              fieldId,
              value
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.updateProjectItemField({
            projectId: table.project.id,
            host: table.project.host,
            itemId: rowId,
            fieldId,
            value
          })
    if (!result.ok) {
      rollbackRowIfPresent(set, get, cacheKey, rowId, previousRow)
    }
    return result
  },

  clearProjectFieldValue: async (cacheKey, rowId, fieldId) => {
    const state = get()
    const entry = state.projectViewCache[cacheKey]
    const table = entry?.data
    if (!table) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.a967f23983', 'Project view not loaded')
        }
      }
    }
    const rowIndex = table.rows.findIndex((r) => r.id === rowId)
    if (rowIndex === -1) {
      return {
        ok: false,
        error: {
          type: 'unknown',
          message: translate('auto.store.slices.github.f963485d37', 'Row not found')
        }
      }
    }
    const previousRow = table.rows[rowIndex]
    const optimisticFieldValues = { ...previousRow.fieldValuesByFieldId }
    delete optimisticFieldValues[fieldId]
    const optimisticRow: GitHubProjectRow = {
      ...previousRow,
      fieldValuesByFieldId: optimisticFieldValues
    }
    applyRowPatch(set, cacheKey, rowId, optimisticRow)

    const target = getActiveRuntimeTarget(settingsForProjectViewCacheKey(get().settings, cacheKey))
    const result =
      target.kind === 'environment'
        ? await callRuntimeRpc<GitHubProjectMutationResult>(
            target,
            'github.project.clearItemField',
            {
              projectId: table.project.id,
              host: table.project.host,
              itemId: rowId,
              fieldId
            },
            { timeoutMs: 30_000 }
          )
        : await window.api.gh.clearProjectItemField({
            projectId: table.project.id,
            host: table.project.host,
            itemId: rowId,
            fieldId
          })
    if (!result.ok) {
      rollbackRowIfPresent(set, get, cacheKey, rowId, previousRow)
    }
    return result
  }
})
