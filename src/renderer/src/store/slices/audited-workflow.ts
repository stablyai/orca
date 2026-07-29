import type { StateCreator } from 'zustand'
import type {
  AuditedTaskStatusProjection,
  AuditedWorkflowSelectTaskParams,
  AuditedWorkflowSelectTaskResult
} from '../../../../shared/audited-workflow-types'
import type { AppState } from '../types'
import { getTaskListErrorMessage } from '../../components/audited-workflow/audited-workflow-error-messages'

export type AuditedWorkflowSlice = {
  auditedTasks: AuditedTaskStatusProjection[]
  auditedTasksLoading: boolean
  auditedTasksError: string | null
  selectedAuditedTaskId: string | null
  refreshAuditedTasks: (repoId?: string) => Promise<void>
  selectAuditedTask: (taskId: string | null) => void
  createAuditedTask: (
    params: AuditedWorkflowSelectTaskParams
  ) => Promise<AuditedWorkflowSelectTaskResult>
  applyAuditedTaskChanged: (projection: AuditedTaskStatusProjection) => void
}

function upsertTask(
  tasks: AuditedTaskStatusProjection[],
  projection: AuditedTaskStatusProjection
): AuditedTaskStatusProjection[] {
  const index = tasks.findIndex((t) => t.taskId === projection.taskId)
  if (index === -1) {
    return [projection, ...tasks]
  }
  const next = tasks.slice()
  next[index] = projection
  return next
}

export const createAuditedWorkflowSlice: StateCreator<AppState, [], [], AuditedWorkflowSlice> = (
  set,
  get
) => ({
  auditedTasks: [],
  auditedTasksLoading: false,
  auditedTasksError: null,
  selectedAuditedTaskId: null,

  refreshAuditedTasks: async (repoId) => {
    set({ auditedTasksLoading: true, auditedTasksError: null })
    try {
      const tasks = await window.api.auditedWorkflow.listTasks(repoId ? { repoId } : undefined)
      set({ auditedTasks: tasks, auditedTasksLoading: false })
    } catch {
      // Why: a failed list load must be visibly distinct from "zero tasks
      // exist" — never silently show an empty list on IPC failure. The
      // underlying error is not renderer-visible; only a user-safe message.
      set({ auditedTasksLoading: false, auditedTasksError: getTaskListErrorMessage() })
    }
  },

  selectAuditedTask: (taskId) => set({ selectedAuditedTaskId: taskId }),

  createAuditedTask: async (params) => {
    const result = await window.api.auditedWorkflow.selectTask(params)
    if (result.ok) {
      set({ selectedAuditedTaskId: result.taskId })
      await get().refreshAuditedTasks(params.repoId)
    }
    return result
  },

  applyAuditedTaskChanged: (projection) =>
    set((state) => ({ auditedTasks: upsertTask(state.auditedTasks, projection) }))
})
