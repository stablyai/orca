import type { StateCreator } from 'zustand'
import type {
  AuditedTaskStatusProjection,
  AuditedWorkflowSelectTaskParams,
  AuditedWorkflowSelectTaskResult,
  AuditedWorkflowStartTriageResult,
  AuditedWorkflowRetryTriageResult,
  AuditedWorkflowProvisionWorktreeResult
} from '../../../../shared/audited-workflow-types'
import type {
  AuditedWorkflowStartExecutionResult,
  AuditedWorkflowCancelExecutionResult,
  AuditedWorkflowRetryExecutionResult
} from '../../../../shared/audited-workflow-command-types'
import type { AppState } from '../types'
import { getTaskListErrorMessage } from '../../components/audited-workflow/audited-workflow-error-messages'

export type AuditedWorkflowSlice = {
  auditedTasks: AuditedTaskStatusProjection[]
  auditedTasksLoading: boolean
  auditedTasksError: string | null
  selectedAuditedTaskId: string | null
  auditedTriageStartingTaskId: string | null
  refreshAuditedTasks: (repoId?: string) => Promise<void>
  selectAuditedTask: (taskId: string | null) => void
  createAuditedTask: (
    params: AuditedWorkflowSelectTaskParams
  ) => Promise<AuditedWorkflowSelectTaskResult>
  startAuditedTaskTriage: (taskId: string) => Promise<AuditedWorkflowStartTriageResult>
  retryAuditedTaskTriage: (taskId: string) => Promise<AuditedWorkflowRetryTriageResult>
  provisionAuditedTaskWorktree: (taskId: string) => Promise<AuditedWorkflowProvisionWorktreeResult>
  auditedExecutionPendingTaskId: string | null
  startAuditedTaskExecution: (taskId: string) => Promise<AuditedWorkflowStartExecutionResult>
  cancelAuditedTaskExecution: (taskId: string) => Promise<AuditedWorkflowCancelExecutionResult>
  retryAuditedTaskExecution: (taskId: string) => Promise<AuditedWorkflowRetryExecutionResult>
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
  auditedTriageStartingTaskId: null,

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

  startAuditedTaskTriage: async (taskId) => {
    set({ auditedTriageStartingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.startTriage({ taskId })
      const projection = await window.api.auditedWorkflow.getTask({ taskId })
      if (projection) {
        set((state) => ({ auditedTasks: upsertTask(state.auditedTasks, projection) }))
      }
      return result
    } finally {
      set({ auditedTriageStartingTaskId: null })
    }
  },

  retryAuditedTaskTriage: async (taskId) => {
    set({ auditedTriageStartingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.retryTriage({ taskId })
      const projection = await window.api.auditedWorkflow.getTask({ taskId })
      if (projection) {
        set((state) => ({ auditedTasks: upsertTask(state.auditedTasks, projection) }))
      }
      return result
    } finally {
      set({ auditedTriageStartingTaskId: null })
    }
  },

  // Why the same pending id as triage: the detail pane shows one combined
  // pending state ("Preparing worktree…"), and recovery must never chain into
  // Start Triage — the user clicks that separately after this resolves.
  provisionAuditedTaskWorktree: async (taskId) => {
    set({ auditedTriageStartingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.provisionWorktree({ taskId })
      const projection = await window.api.auditedWorkflow.getTask({ taskId })
      if (projection) {
        set((state) => ({ auditedTasks: upsertTask(state.auditedTasks, projection) }))
      }
      return result
    } finally {
      set({ auditedTriageStartingTaskId: null })
    }
  },

  auditedExecutionPendingTaskId: null,

  startAuditedTaskExecution: async (taskId) => {
    set({ auditedExecutionPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.startExecution({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedExecutionPendingTaskId: null })
    }
  },

  cancelAuditedTaskExecution: async (taskId) => {
    set({ auditedExecutionPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.cancelExecution({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedExecutionPendingTaskId: null })
    }
  },

  // Returns the result so the component can hold a transient worktree reason.
  // Deliberately does NOT chain into provisionAuditedTaskWorktree on a worktree
  // failure: an execution-blocked task is not admissible to recovery, so that
  // call would return notAdmissible every time.
  retryAuditedTaskExecution: async (taskId) => {
    set({ auditedExecutionPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.retryExecution({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedExecutionPendingTaskId: null })
    }
  },

  applyAuditedTaskChanged: (projection) =>
    set((state) => ({ auditedTasks: upsertTask(state.auditedTasks, projection) }))
})

async function refreshOneTask(
  set: (fn: (state: AppState) => Partial<AppState>) => void,
  taskId: string
): Promise<void> {
  const projection = await window.api.auditedWorkflow.getTask({ taskId })
  if (projection) {
    set((state) => ({ auditedTasks: upsertTask(state.auditedTasks, projection) }))
  }
}
