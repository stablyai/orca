// Phase 8 store actions: approve, revoke, and commit.
//
// Split from audited-workflow.ts so that slice stays within its line budget
// without a max-lines suppression. Composed into the slice with a spread, so the
// state shape and every existing action are unchanged.
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'
import type { ApprovalTtlPreset } from '../../../../shared/audited-workflow-types'
import type {
  AuditedWorkflowApproveResult,
  AuditedWorkflowCommitResult,
  AuditedWorkflowRevokeApprovalResult
} from '../../../../shared/audited-workflow-command-types'

export type AuditedCommitActions = {
  // Its own pending id, for the same reason the code-audit lane has one: a commit
  // click must not disable an approval button on a DIFFERENT task in the list.
  auditedCommitPendingTaskId: string | null
  approveAuditedCommit: (
    taskId: string,
    ttlPreset: ApprovalTtlPreset
  ) => Promise<AuditedWorkflowApproveResult>
  revokeAuditedApproval: (taskId: string) => Promise<AuditedWorkflowRevokeApprovalResult>
  commitAuditedTask: (taskId: string, message: string) => Promise<AuditedWorkflowCommitResult>
}

type SetState = (
  partial:
    | Partial<{ auditedCommitPendingTaskId: string | null }>
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

export function createAuditedCommitActions(set: SetState): AuditedCommitActions {
  return {
    auditedCommitPendingTaskId: null,

    approveAuditedCommit: async (taskId, ttlPreset) => {
      set({ auditedCommitPendingTaskId: taskId })
      try {
        const result = await window.api.auditedWorkflow.approve({ taskId, ttlPreset })
        await refreshOneTask(set, taskId)
        return result
      } finally {
        set({ auditedCommitPendingTaskId: null })
      }
    },

    revokeAuditedApproval: async (taskId) => {
      set({ auditedCommitPendingTaskId: taskId })
      try {
        const result = await window.api.auditedWorkflow.revokeApproval({ taskId })
        await refreshOneTask(set, taskId)
        return result
      } finally {
        set({ auditedCommitPendingTaskId: null })
      }
    },

    commitAuditedTask: async (taskId, message) => {
      set({ auditedCommitPendingTaskId: taskId })
      try {
        const result = await window.api.auditedWorkflow.commit({ taskId, message })
        await refreshOneTask(set, taskId)
        return result
      } finally {
        set({ auditedCommitPendingTaskId: null })
      }
    }
  }
}
