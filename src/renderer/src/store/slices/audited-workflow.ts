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
  AuditedWorkflowRetryExecutionResult,
  AuditedWorkflowStartPlanAuditResult,
  AuditedWorkflowCancelPlanAuditResult,
  AuditedWorkflowRetryPlanAuditResult,
  AuditedWorkflowApprovePlanResult,
  AuditedWorkflowRequestPlanRevisionResult,
  AuditedWorkflowCodeAuditResult,
  AuditedWorkflowGetPlanArtifactResult
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
  // Phase 5 plan review. One pending id for the whole block, matching the
  // execution-controls idiom: the panel shows a single busy state.
  auditedPlanReviewPendingTaskId: string | null
  startAuditedPlanAudit: (taskId: string) => Promise<AuditedWorkflowStartPlanAuditResult>
  cancelAuditedPlanAudit: (taskId: string) => Promise<AuditedWorkflowCancelPlanAuditResult>
  retryAuditedPlanAudit: (taskId: string) => Promise<AuditedWorkflowRetryPlanAuditResult>
  approveAuditedPlan: (taskId: string) => Promise<AuditedWorkflowApprovePlanResult>
  requestAuditedPlanRevision: (taskId: string) => Promise<AuditedWorkflowRequestPlanRevisionResult>
  auditedCodeAuditPendingTaskId: string | null
  startAuditedCodeAudit: (taskId: string) => Promise<AuditedWorkflowCodeAuditResult>
  cancelAuditedCodeAudit: (taskId: string) => Promise<AuditedWorkflowCodeAuditResult>
  retryAuditedCodeAudit: (taskId: string) => Promise<AuditedWorkflowCodeAuditResult>
  requestAuditedCodeFix: (taskId: string) => Promise<AuditedWorkflowCodeAuditResult>
  // Cached by artifactId, NOT by taskId: a new round produces a new artifact id,
  // so a stale body can never be shown next to a newer round's metadata.
  auditedPlanArtifactBodies: Record<string, string>
  loadAuditedPlanArtifact: (
    taskId: string,
    artifactId: string
  ) => Promise<AuditedWorkflowGetPlanArtifactResult>
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
    set((state) => ({ auditedTasks: upsertTask(state.auditedTasks, projection) })),

  auditedPlanReviewPendingTaskId: null,
  auditedPlanArtifactBodies: {},

  // Phase 7. A separate pending id from the plan lane: the two lanes are never
  // active for the same task, but sharing one id would make a code-audit click
  // disable a plan-lane button on a DIFFERENT task in the list.
  auditedCodeAuditPendingTaskId: null,

  startAuditedCodeAudit: async (taskId) => {
    set({ auditedCodeAuditPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.startCodeAudit({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedCodeAuditPendingTaskId: null })
    }
  },

  cancelAuditedCodeAudit: async (taskId) => {
    set({ auditedCodeAuditPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.cancelCodeAudit({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedCodeAuditPendingTaskId: null })
    }
  },

  retryAuditedCodeAudit: async (taskId) => {
    set({ auditedCodeAuditPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.retryCodeAudit({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedCodeAuditPendingTaskId: null })
    }
  },

  requestAuditedCodeFix: async (taskId) => {
    set({ auditedCodeAuditPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.requestCodeFix({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedCodeAuditPendingTaskId: null })
    }
  },

  startAuditedPlanAudit: async (taskId) => {
    set({ auditedPlanReviewPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.startPlanAudit({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedPlanReviewPendingTaskId: null })
    }
  },

  cancelAuditedPlanAudit: async (taskId) => {
    set({ auditedPlanReviewPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.cancelPlanAudit({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedPlanReviewPendingTaskId: null })
    }
  },

  retryAuditedPlanAudit: async (taskId) => {
    set({ auditedPlanReviewPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.retryPlanAudit({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedPlanReviewPendingTaskId: null })
    }
  },

  approveAuditedPlan: async (taskId) => {
    set({ auditedPlanReviewPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.approvePlan({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedPlanReviewPendingTaskId: null })
    }
  },

  // Deliberately does NOT chain into anything on failure: a refused revision
  // leaves the task exactly where it was, and the panel renders the closed code.
  requestAuditedPlanRevision: async (taskId) => {
    set({ auditedPlanReviewPendingTaskId: taskId })
    try {
      const result = await window.api.auditedWorkflow.requestPlanRevision({ taskId })
      await refreshOneTask(set, taskId)
      return result
    } finally {
      set({ auditedPlanReviewPendingTaskId: null })
    }
  },

  loadAuditedPlanArtifact: async (taskId, artifactId) => {
    const result = await window.api.auditedWorkflow.getPlanArtifact({ taskId, artifactId })
    if (result.ok) {
      set((state) => ({
        auditedPlanArtifactBodies: {
          ...state.auditedPlanArtifactBodies,
          [artifactId]: result.text
        }
      }))
    }
    return result
  }
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
