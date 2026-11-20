import { z } from 'zod'
import { isPublicOrchestrationAddress } from './mailbox/orchestration-agent-reference'
import { WorkerApprovalPayloadSchema } from './approvals/worker-approval-payload'
import { parseOrcaSessionAddress } from '../agent-session/identity/orca-session-address'

export const CrewParty = z.string().refine(isPublicOrchestrationAddress)
export const CrewSubscribeParams = z.object({
  party: CrewParty,
  /** `summary` sends counts alone until rows are asked for; older hosts ignore it and send rows. */
  view: z.enum(['summary', 'rows']).optional(),
  /** Rows after the first snapshot arrive as changes; older hosts ignore it and resend every row. */
  deltas: z.boolean().optional()
})
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
  /** The party's newest message to the viewer; `latest` may be a newer one the viewer sent. */
  reply: z.object({ preview: z.string(), at: z.string(), sequence: z.number() }).optional(),
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
  // Sent only to a `deltas` subscriber after its first snapshot: every section's party keys in order,
  // then `rows` frames for the rows that changed or are new, then `complete`.
  z.object({
    type: z.literal('delta'),
    status: z.enum(['ok', 'unknown']),
    order: z.object({
      managedBy: z.array(z.string()),
      managing: z.array(z.string()),
      talkingWith: z.array(z.string())
    })
  }),
  z.object({ type: z.literal('end') }),
  // Sent only to a `summary` subscriber, so clients that never ask never see it.
  z.object({
    type: z.literal('summary'),
    status: z.enum(['ok', 'unknown']),
    agents: z.number(),
    needsYou: z.number()
  })
])
export type OrchestrationCrewFrame = z.infer<typeof CrewFrame>

/** A chat coordinator's worker approvals alone, so a chat need not follow its whole crew. */
export const WorkerApprovalsSubscribeParams = z.object({
  party: CrewParty.refine((party) => parseOrcaSessionAddress(party) !== null)
})
/** Ends one approvals stream on this connection, named by its subscribe request's id. */
export const WorkerApprovalsUnsubscribeParams = z.object({ subscriptionId: z.string().min(1) })
export const WorkerApprovalEntry = CrewRowApproval.extend({
  worker: CrewRow.omit({ approvals: true })
})
export type OrchestrationWorkerApprovalEntry = z.infer<typeof WorkerApprovalEntry>
export const WorkerApprovalsFrame = z.discriminatedUnion('type', [
  z.object({ type: z.literal('begin') }),
  // One approval per frame: a frame stays small whatever the count.
  z.object({ type: z.literal('approval'), entry: WorkerApprovalEntry }),
  z.object({ type: z.literal('complete') }),
  // Sent only to a `deltas` subscriber after its first snapshot: every section's party keys in order,
  // then `rows` frames for the rows that changed or are new, then `complete`.
  z.object({
    type: z.literal('delta'),
    status: z.enum(['ok', 'unknown']),
    order: z.object({
      managedBy: z.array(z.string()),
      managing: z.array(z.string()),
      talkingWith: z.array(z.string())
    })
  }),
  z.object({ type: z.literal('end') })
])
export type OrchestrationWorkerApprovalsFrame = z.infer<typeof WorkerApprovalsFrame>
export function emptyCrew(status: 'ok' | 'unknown'): OrchestrationCrewSnapshot {
  return { status, sections: { managedBy: [], managing: [], talkingWith: [] } }
}

export type OrchestrationCrewSummary = {
  status: 'ok' | 'unknown'
  agents: number
  needsYou: number
}

/** A worker of this party waiting on the person's approval or answer; a question to its coordinator is not. */
export function crewRowNeedsYou(row: Pick<OrchestrationCrewRow, 'role' | 'status'>): boolean {
  return row.role === 'worker' && (row.status === 'waiting' || row.status === 'blocked')
}

/** The manager and workers once each, and the managed workers waiting on the person. */
export function crewSummary(snapshot: OrchestrationCrewSnapshot): OrchestrationCrewSummary {
  const parties = new Set<string>()
  for (const section of [snapshot.sections.managedBy, snapshot.sections.managing]) {
    for (const row of section) {
      parties.add(row.partyKey)
    }
  }
  return {
    status: snapshot.status,
    agents: parties.size,
    needsYou: snapshot.sections.managing.filter(crewRowNeedsYou).length
  }
}
