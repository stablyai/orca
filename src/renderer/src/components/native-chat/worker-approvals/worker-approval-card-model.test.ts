import { expect, it } from 'vitest'
import { workerApprovalReceiptBody } from './worker-approval-card-model'

const COMMAND =
  'rm -rf ~/orca/repoF/scratch/a ~/orca/repoF/scratch/b ~/orca/repoF/scratch/c && echo removed-all-three'

it("shows a chat worker's whole command on the receipt, not its tool input as JSON", () => {
  const body = workerApprovalReceiptBody(
    {
      v: 1,
      approvalId: 'item_1',
      state: 'answered',
      worker: { handle: 'structworker_1', dispatchId: 'ctx_1', taskId: 'task_1' },
      summary: {
        title: 'Allow Bash?',
        detail: JSON.stringify({ command: COMMAND, description: 'Remove scratch' }, null, 2),
        reason: null
      },
      allowedActions: [],
      outcome: { by: 'coordinator', decision: 'allow', reason: 'scratch', reasonDelivered: false }
    },
    '2026-11-11T19:58:00.000Z',
    (_key: string, fallback: string) => fallback
  )

  expect(body.detail).toBe(COMMAND)
})
