// Phase 5 plan-review store actions.
//
// Split from audited-workflow.ts so that slice stays within its line budget
// without a max-lines suppression; composed back in with a spread, so the state
// shape and behavior are unchanged.
import type {
  AuditedWorkflowApprovePlanResult,
  AuditedWorkflowCancelPlanAuditResult,
  AuditedWorkflowRequestPlanRevisionResult,
  AuditedWorkflowRetryPlanAuditResult,
  AuditedWorkflowStartPlanAuditResult
} from '../../../../shared/audited-workflow-command-types'
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'

export type AuditedPlanReviewActions = {
  // One pending id for the whole block, matching the execution-controls idiom:
  // the panel shows a single busy state.
  auditedPlanReviewPendingTaskId: string | null
  startAuditedPlanAudit: (taskId: string) => Promise<AuditedWorkflowStartPlanAuditResult>
  cancelAuditedPlanAudit: (taskId: string) => Promise<AuditedWorkflowCancelPlanAuditResult>
  retryAuditedPlanAudit: (taskId: string) => Promise<AuditedWorkflowRetryPlanAuditResult>
  approveAuditedPlan: (taskId: string) => Promise<AuditedWorkflowApprovePlanResult>
  requestAuditedPlanRevision: (taskId: string) => Promise<AuditedWorkflowRequestPlanRevisionResult>
}

type SetState = (
  partial:
    | Partial<{ auditedPlanReviewPendingTaskId: string | null }>
    | ((state: {
        auditedTasks: AuditedTaskStatusProjection[]
      }) => Partial<{ auditedTasks: AuditedTaskStatusProjection[] }>)
) => void

async function refreshOneTask(set: SetState, taskId: string): Promise<void> {
  const projection = await window.api.auditedWorkflow.getTask({ taskId })
  if (projection) {
    set((state) => {
      const index = state.auditedTasks.findIndex((t) => t.taskId === projection.taskId)
      if (index === -1) {
        return { auditedTasks: [projection, ...state.auditedTasks] }
      }
      const next = state.auditedTasks.slice()
      next[index] = projection
      return { auditedTasks: next }
    })
  }
}

export function createAuditedPlanReviewActions(set: SetState): AuditedPlanReviewActions {
  return {
    auditedPlanReviewPendingTaskId: null,

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
    }
  }
}
