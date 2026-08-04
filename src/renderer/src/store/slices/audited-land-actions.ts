// Phase 10 store actions: land and recheck land.
//
// Split from audited-workflow.ts so that slice stays within its line budget
// without a max-lines suppression. Composed into the slice with a spread, so the
// state shape and every existing action are unchanged.
//
// TWO SEPARATE PENDING IDS. Recheck is offered exactly when Land is not, so one
// in-flight action must never disable an unrelated one on the same or a
// different task.
import type { AuditedTaskStatusProjection } from '../../../../shared/audited-workflow-types'
import type {
  AuditedWorkflowLandResult,
  AuditedWorkflowRecheckLandResult
} from '../../../../shared/audited-workflow-command-types'

export type AuditedLandActions = {
  auditedLandPendingTaskId: string | null
  auditedLandRecheckPendingTaskId: string | null
  landAuditedTask: (taskId: string) => Promise<AuditedWorkflowLandResult>
  recheckAuditedLand: (taskId: string) => Promise<AuditedWorkflowRecheckLandResult>
}

type PendingKeys = {
  auditedLandPendingTaskId: string | null
  auditedLandRecheckPendingTaskId: string | null
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

export function createAuditedLandActions(set: SetState): AuditedLandActions {
  return {
    auditedLandPendingTaskId: null,
    auditedLandRecheckPendingTaskId: null,

    landAuditedTask: async (taskId) => {
      set({ auditedLandPendingTaskId: taskId })
      try {
        const result = await window.api.auditedWorkflow.land({ taskId })
        await refreshOneTask(set, taskId)
        return result
      } finally {
        set({ auditedLandPendingTaskId: null })
      }
    },

    recheckAuditedLand: async (taskId) => {
      set({ auditedLandRecheckPendingTaskId: taskId })
      try {
        const result = await window.api.auditedWorkflow.recheckLand({ taskId })
        await refreshOneTask(set, taskId)
        return result
      } finally {
        set({ auditedLandRecheckPendingTaskId: null })
      }
    }
  }
}
