import { clickupApiForTarget } from '@/runtime/clickup/runtime-clickup-client'
import { taskSourceRuntimeTarget } from '@/lib/work-items/task-source-runtime-target'
import type { ClickUpApi } from '../../../../../preload/api/work-items/clickup-api'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { ClickUpTask } from '../../../../../shared/clickup/clickup-types'
import { clickupWorkspaceCachePrefix, getClickUpReadScope } from './clickup-read-coordination'
import type { ClickUpSlice, ClickUpSliceGet, ClickUpSliceSet } from './clickup-slice-contract'

type ClickUpWriteActions = Pick<ClickUpSlice, 'addClickUpTaskComment' | 'updateClickUpTaskStatus'>

/** Rewrites the task's cached copies for one runtime and Workspace, in task caches and list pages alike, whichever source cached them. */
function rewriteCachedClickUpTask(
  set: ClickUpSliceSet,
  prefix: string,
  taskId: string,
  rewrite: (task: ClickUpTask) => ClickUpTask
): void {
  set((state) => {
    let changed = false
    const rewriteIfCached = (task: ClickUpTask): ClickUpTask => {
      if (task.id !== taskId) {
        return task
      }
      const next = rewrite(task)
      changed ||= next !== task
      return next
    }
    const clickupTaskCache = { ...state.clickupTaskCache }
    for (const [key, entry] of Object.entries(clickupTaskCache)) {
      if (key.startsWith(prefix) && entry.data) {
        const data = rewriteIfCached(entry.data)
        if (data !== entry.data) {
          clickupTaskCache[key] = { ...entry, data }
        }
      }
    }
    const clickupListCache = { ...state.clickupListCache }
    for (const [key, entry] of Object.entries(clickupListCache)) {
      if (key.startsWith(prefix) && entry.data) {
        const { tasks } = entry.data
        const rewritten = tasks.map(rewriteIfCached)
        // Pages without the task keep their identity so their subscribers do not re-render.
        if (rewritten.some((next, index) => next !== tasks[index])) {
          clickupListCache[key] = { ...entry, data: { ...entry.data, tasks: rewritten } }
        }
      }
    }
    return changed ? { clickupTaskCache, clickupListCache } : state
  })
}

export function createClickUpWriteActions(
  set: ClickUpSliceSet,
  get: ClickUpSliceGet
): ClickUpWriteActions {
  const apiFor = (sourceContext: TaskSourceContext): ClickUpApi =>
    clickupApiForTarget(taskSourceRuntimeTarget(sourceContext))

  return {
    addClickUpTaskComment: async (id, body, options) => {
      const result = await apiFor(options.sourceContext).addTaskComment({ id, body })
      if (result.ok) {
        // The reply carries only the new comment's id, so reread the thread to show it in order.
        await get()
          .listClickUpTaskComments(id, { sourceContext: options.sourceContext, force: true })
          .catch(() => undefined)
      }
      return result
    },

    updateClickUpTaskStatus: async (task, status, options) => {
      // Computed once: the Workspace slot may change while the write is out, and the rollback must hit the same entries.
      const scope = getClickUpReadScope(get(), options.sourceContext)
      const prefix = clickupWorkspaceCachePrefix(scope.runtimeContextKey, scope.workspaceKey)
      rewriteCachedClickUpTask(set, prefix, task.id, (cached) => ({ ...cached, status }))
      let result
      try {
        result = await apiFor(options.sourceContext).updateTask({
          id: task.id,
          updates: { status: status.name }
        })
      } catch (error) {
        result = {
          ok: false as const,
          error: error instanceof Error ? error.message : 'Status update failed'
        }
      }
      if (result.ok) {
        // Reread so server-side effects of the change (completion dates, automations) show up.
        void get()
          .fetchClickUpTask(task.id, { sourceContext: options.sourceContext, force: true })
          .catch(() => undefined)
        return result
      }
      // Only copies still holding the optimistic status roll back, so a newer write or read elsewhere survives.
      rewriteCachedClickUpTask(set, prefix, task.id, (cached) =>
        cached.status === status ? { ...cached, status: task.status } : cached
      )
      return result
    }
  }
}
