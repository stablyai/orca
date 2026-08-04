// Phase 9 store actions: publish, recheck outcome, and create review request.
//
// Split from audited-workflow.ts so that slice stays within its line budget
// without a max-lines suppression. Composed into the slice with a spread, so the
// state shape and every existing action are unchanged.
//
// THREE SEPARATE PENDING IDS. Recheck is offered exactly when Publish is not, and
// the review-request retry can run alongside neither — one in-flight action must
// never disable an unrelated one on the same or a different task.
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'
import type {
  AuditedWorkflowCreateReviewRequestResult,
  AuditedWorkflowPublishResult,
  AuditedWorkflowRecheckPublishResult
} from '../../../../shared/audited-workflow-command-types'

export type AuditedPublishActions = {
  auditedPublishPendingTaskId: string | null
  auditedPublishRecheckPendingTaskId: string | null
  auditedReviewRequestPendingTaskId: string | null
  publishAuditedTask: (taskId: string) => Promise<AuditedWorkflowPublishResult>
  recheckAuditedPublish: (taskId: string) => Promise<AuditedWorkflowRecheckPublishResult>
  createAuditedReviewRequest: (taskId: string) => Promise<AuditedWorkflowCreateReviewRequestResult>
}

type PendingKeys = {
  auditedPublishPendingTaskId: string | null
  auditedPublishRecheckPendingTaskId: string | null
  auditedReviewRequestPendingTaskId: string | null
}

type SetState = (
  partial:
    | Partial<PendingKeys>
    | ((state: {
        auditedTasks: AuditedTaskStatusProjection[]
      }) => Partial<{ auditedTasks: AuditedTaskStatusProjection[] }>)
) => void

/**
 * Re-reads the task after a command so the projection reflects whatever the
 * server actually decided — the same belt-and-braces refresh every other lane
 * performs alongside the broadcast.
 */
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

export function createAuditedPublishActions(set: SetState): AuditedPublishActions {
  return {
    auditedPublishPendingTaskId: null,
    auditedPublishRecheckPendingTaskId: null,
    auditedReviewRequestPendingTaskId: null,

    publishAuditedTask: async (taskId) => {
      set({ auditedPublishPendingTaskId: taskId })
      try {
        const result = await window.api.auditedWorkflow.publish({ taskId })
        await refreshOneTask(set, taskId)
        return result
      } finally {
        set({ auditedPublishPendingTaskId: null })
      }
    },

    recheckAuditedPublish: async (taskId) => {
      set({ auditedPublishRecheckPendingTaskId: taskId })
      try {
        const result = await window.api.auditedWorkflow.recheckPublish({ taskId })
        await refreshOneTask(set, taskId)
        return result
      } finally {
        set({ auditedPublishRecheckPendingTaskId: null })
      }
    },

    createAuditedReviewRequest: async (taskId) => {
      set({ auditedReviewRequestPendingTaskId: taskId })
      try {
        const result = await window.api.auditedWorkflow.createReviewRequest({ taskId })
        await refreshOneTask(set, taskId)
        return result
      } finally {
        set({ auditedReviewRequestPendingTaskId: null })
      }
    }
  }
}
