import { z } from 'zod'
import { isPublicOrchestrationAddress } from './orchestration-agent-reference'

export const CrewParty = z.string().refine(isPublicOrchestrationAddress)
export const CrewSubscribeParams = z.object({ party: CrewParty })
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
export function emptyCrew(status: 'ok' | 'unknown'): OrchestrationCrewSnapshot {
  return { status, sections: { managedBy: [], managing: [], talkingWith: [] } }
}
