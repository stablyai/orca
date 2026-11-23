import {
  clickupApiForTarget,
  clickupSearchTasksForTarget
} from '@/runtime/clickup/runtime-clickup-client'
import type { ClickUpApi } from '../../../../../preload/api/work-items/clickup-api'
import type { ClickUpSlice, ClickUpSliceGet, ClickUpSliceSet } from './clickup-slice-contract'
import {
  cachedClickUpRead,
  clickupCacheKey,
  clickupListCacheKey,
  clickupSearchCacheKey,
  clickupTaskCacheKey,
  evictStaleClickUpCacheEntries,
  getClickUpReadScope,
  type ClickUpReadScope
} from './clickup-read-coordination'

type ClickUpReadActions = Pick<
  ClickUpSlice,
  | 'listClickUpTasks'
  | 'searchClickUpTasks'
  | 'fetchClickUpTask'
  | 'listClickUpTaskComments'
  | 'listClickUpStatusOptions'
>

function apiFor(scope: ClickUpReadScope): ClickUpApi {
  return clickupApiForTarget(scope.target)
}

export function createClickUpReadActions(
  set: ClickUpSliceSet,
  get: ClickUpSliceGet
): ClickUpReadActions {
  return {
    listClickUpTasks: ({ filter, page }, options) => {
      const scope = getClickUpReadScope(get(), options.sourceContext)
      const key = clickupListCacheKey(get(), options.sourceContext, { filter, page })
      return cachedClickUpRead({
        key,
        scope,
        get,
        force: options.force,
        peek: () => get().clickupListCache[key],
        store: (entry) =>
          set((state) => ({
            clickupListCache: evictStaleClickUpCacheEntries({
              ...state.clickupListCache,
              [key]: entry
            })
          })),
        load: () => apiFor(scope).listTasks({ filter, page })
      })
    },

    searchClickUpTasks: async (query, filter, options) => {
      const scope = getClickUpReadScope(get(), options.sourceContext)
      const key = clickupSearchCacheKey(get(), options.sourceContext, { query, filter })
      const result = await cachedClickUpRead({
        key,
        scope,
        get,
        force: options.force,
        signal: options.signal,
        peek: () => get().clickupListCache[key],
        store: (entry) =>
          set((state) => ({
            clickupListCache: evictStaleClickUpCacheEntries({
              ...state.clickupListCache,
              [key]: entry
            })
          })),
        load: async () => ({
          tasks: await clickupSearchTasksForTarget(
            scope.target,
            { query, filter, fresh: options.force },
            options.signal
          ),
          nextPage: null
        })
      })
      return result.tasks
    },

    fetchClickUpTask: (id, options) => {
      const scope = getClickUpReadScope(get(), options.sourceContext)
      const key = clickupTaskCacheKey(get(), options.sourceContext, id)
      // A missing task is not cached, so a task created or shared after a miss is found on the next read.
      return cachedClickUpRead({
        key,
        scope,
        get,
        force: options.force,
        peek: () => get().clickupTaskCache[key],
        store: (entry) => {
          const task = entry.data
          if (task) {
            set((state) => ({
              clickupTaskCache: evictStaleClickUpCacheEntries({
                ...state.clickupTaskCache,
                [key]: { ...entry, data: task }
              })
            }))
          }
        },
        load: () => apiFor(scope).getTask({ id })
      })
    },

    listClickUpTaskComments: (id, options) => {
      const scope = getClickUpReadScope(get(), options.sourceContext)
      const key = clickupCacheKey(scope, `comments::${id}`)
      return cachedClickUpRead({
        key,
        scope,
        get,
        force: options.force,
        peek: () => get().clickupCommentCache[key],
        store: (entry) =>
          set((state) => ({
            clickupCommentCache: evictStaleClickUpCacheEntries({
              ...state.clickupCommentCache,
              [key]: entry
            })
          })),
        load: () => apiFor(scope).taskComments({ id })
      })
    },

    listClickUpStatusOptions: (listId, options) => {
      const scope = getClickUpReadScope(get(), options.sourceContext)
      const key = clickupCacheKey(scope, `statuses::${listId}`)
      return cachedClickUpRead({
        key,
        scope,
        get,
        force: options.force,
        peek: () => get().clickupStatusOptionsCache[key],
        store: (entry) =>
          set((state) => ({
            clickupStatusOptionsCache: evictStaleClickUpCacheEntries({
              ...state.clickupStatusOptionsCache,
              [key]: entry
            })
          })),
        load: () => apiFor(scope).listStatuses({ listId })
      })
    }
  }
}
