import { clickupApiForTarget } from '@/runtime/clickup/runtime-clickup-client'
import { taskSourceRuntimeTarget } from '@/lib/work-items/task-source-runtime-target'
import type { ClickUpApi } from '../../../../../preload/api/work-items/clickup-api'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import type { ClickUpTask } from '../../../../../shared/clickup/clickup-types'
import type { ClickUpSlice, ClickUpSliceGet, ClickUpSliceSet } from './clickup-slice-contract'

type ClickUpWriteActions = Pick<ClickUpSlice, 'addClickUpTaskComment' | 'updateClickUpTaskStatus'>

/** Applies `patch` to every cached copy of the task, in task caches and list pages alike. */
function patchCachedClickUpTask(
  set: ClickUpSliceSet,
  taskId: string,
  patch: Partial<ClickUpTask>
): void {
  set((state) => {
    let changed = false
    const clickupTaskCache = { ...state.clickupTaskCache }
    for (const [key, entry] of Object.entries(clickupTaskCache)) {
      if (entry.data?.id === taskId) {
        clickupTaskCache[key] = { ...entry, data: { ...entry.data, ...patch } }
        changed = true
      }
    }
    const clickupListCache = { ...state.clickupListCache }
    for (const [key, entry] of Object.entries(clickupListCache)) {
      if (entry.data?.tasks.some((task) => task.id === taskId)) {
        clickupListCache[key] = {
          ...entry,
          data: {
            ...entry.data,
            tasks: entry.data.tasks.map((task) =>
              task.id === taskId ? { ...task, ...patch } : task
            )
          }
        }
        changed = true
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
      patchCachedClickUpTask(set, task.id, { status })
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
      patchCachedClickUpTask(set, task.id, { status: task.status })
      return result
    }
  }
}
