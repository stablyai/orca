import { z } from 'zod'
import { isPublicOrchestrationAddress } from './mailbox/orchestration-agent-reference'
import { WorkerApprovalPayloadSchema } from './approvals/worker-approval-payload'
import { parseOrcaSessionAddress } from '../orca-session-address'

export const CrewParty = z.string().refine(isPublicOrchestrationAddress)
export const CrewSubscribeParams = z.object({ party: CrewParty })
const CrewRowApproval = z.object({
  approval: WorkerApprovalPayloadSchema,
  at: z.string(),
  /** When the worker asked: where its card sits in the chat, open or answered. */
  askedAt: z.string().optional()
})
export const CrewRow = z.object({
  partyKey: z.string(),
  role: z.enum(['manager', 'worker', 'peer']),
  label: z.string(),
  agentKind: z.string(),
  hostLabel: z.string().optional(),
  status: z.string(),
  task: z.object({ title: z.string(), state: z.string() }).optional(),
  progress: z.string().optional(),
  latest: z
    .object({
      direction: z.enum(['to', 'from']),
      preview: z.string(),
      at: z.string(),
      sequence: z.number()
    })
    .optional(),
  pendingQuestion: z.object({ preview: z.string(), at: z.string() }).optional(),
  /** This worker's permission prompts addressed to the viewing party, each as its newest message: open ones, and recent receipts. */
  approvals: z.array(CrewRowApproval).optional(),
  sendAddress: CrewParty.optional(),
  openTarget: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('chat'), sessionId: z.string(), worktreeId: z.string() }),
      z.object({ kind: z.literal('terminal'), handle: z.string() }),
      z.object({ kind: z.literal('dispatch'), address: z.string() })
    ])
    .optional()
})
export type OrchestrationCrewRow = z.infer<typeof CrewRow>
export const CrewSnapshot = z.object({
  status: z.enum(['ok', 'unknown']),
  sections: z.object({
    managedBy: z.array(CrewRow),
    managing: z.array(CrewRow),
    talkingWith: z.array(CrewRow)
  })
})
export type OrchestrationCrewSnapshot = z.infer<typeof CrewSnapshot>
export const CrewFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('begin'), status: z.enum(['ok', 'unknown']) }),
  z.object({
    type: z.literal('rows'),
    section: z.enum(['managedBy', 'managing', 'talkingWith']),
    rows: z.array(CrewRow)
  }),
  z.object({ type: z.literal('complete') }),
  z.object({ type: z.literal('end') })
])
export type OrchestrationCrewFrame = z.infer<typeof CrewFrame>

/** A chat coordinator's worker approvals alone, so a chat need not follow its whole crew. */
export const WorkerApprovalsSubscribeParams = z.object({
  party: CrewParty.refine((party) => parseOrcaSessionAddress(party) !== null)
})
export const WorkerApprovalEntry = CrewRowApproval.extend({
  worker: CrewRow.omit({ approvals: true })
})
export type OrchestrationWorkerApprovalEntry = z.infer<typeof WorkerApprovalEntry>
export const WorkerApprovalsFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('begin') }),
  // One approval per frame: a frame stays small whatever the count.
  z.object({ type: z.literal('approval'), entry: WorkerApprovalEntry }),
  z.object({ type: z.literal('complete') }),
  z.object({ type: z.literal('end') })
])
export type OrchestrationWorkerApprovalsFrame = z.infer<typeof WorkerApprovalsFrame>
export function emptyCrew(status: 'ok' | 'unknown'): OrchestrationCrewSnapshot {
  return { status, sections: { managedBy: [], managing: [], talkingWith: [] } }
}
