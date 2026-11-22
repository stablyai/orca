import { z } from 'zod'

// What a paired server and the Orca that coordinates a Run on it exchange about that Run's workers
// (contract-b1-b3). The server owns the workers; these carry its facts home, in its order.

/** The coordinator's Run a call is about, and the conversation its queue items come home under. */
export const RemoteOwnedPeerRun = z.object({
  runId: z.string().min(1).max(256),
  conversationId: z.string().min(1).max(256),
  label: z.string().min(1).max(256)
})
export type RemoteOwnedPeerRun = z.infer<typeof RemoteOwnedPeerRun>

export const REMOTE_OWNED_WIRE_VERSION = 1

const Header = {
  v: z.literal(REMOTE_OWNED_WIRE_VERSION),
  id: z.string().min(1),
  homeRunId: z.string().min(1),
  peerRunId: z.string().min(1)
}

/** A final message filed in the peer Run's mailbox, with the Dispatch and Task its sender worked for. */
export const RemoteOwnedWorkerMail = z.object({
  ...Header,
  message: z.object({
    from: z.string().min(1),
    type: z.enum([
      'status',
      'dispatch',
      'worker_done',
      'merge_ready',
      'escalation',
      'handoff',
      'decision_gate',
      'question'
    ]),
    subject: z.string(),
    body: z.string(),
    payload: z.string().nullable(),
    priority: z.enum(['normal', 'high', 'urgent']),
    threadId: z.string().nullable()
  }),
  dispatchId: z.string().min(1).nullable(),
  taskId: z.string().min(1).nullable()
})
export type RemoteOwnedWorkerMail = z.infer<typeof RemoteOwnedWorkerMail>

/** A peer-Run Dispatch, its worker or its Task changed state on the server, or the server's reset removed it. */
export const RemoteOwnedWorkerState = z.object({
  ...Header,
  dispatch: z.object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    status: z.enum(['pending', 'dispatched', 'completed', 'failed', 'circuit_broken']),
    workerState: z.string().min(1).nullable(),
    lastFailure: z.string().nullable(),
    agent: z.string().nullable()
  }),
  task: z.object({
    status: z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']),
    result: z.string().nullable()
  }),
  /** The server's report owner settled this change through its unobserved-prompt correction. */
  correctedUnobservedPrompt: z.boolean(),
  removed: z.object({ reason: z.string().min(1) }).nullable()
})
export type RemoteOwnedWorkerState = z.infer<typeof RemoteOwnedWorkerState>

export const REMOTE_OWNED_ITEM_KINDS = {
  worker_mail: RemoteOwnedWorkerMail,
  worker_state: RemoteOwnedWorkerState
} as const

/** Params of orchestration.peerRunCancel; the Run comes from the call's peer-Run envelope. */
export const PeerRunCancelParams = z.object({}).strict()

/** Dispatches in the peer Run the server has not proven terminal after running the ordinary stop on each. */
export const PeerRunCancelResult = z.object({ remaining: z.number().int().nonnegative() })
