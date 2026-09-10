export const MAESTRO_COORDINATOR_HANDOFF_PHASES = [
  'reserved',
  'spawned',
  'capsule_delivery_acknowledged',
  'coordinator_claimed',
  'authority_committed',
  'predecessor_reconciled'
] as const

export type MaestroCoordinatorHandoffPhase = (typeof MAESTRO_COORDINATOR_HANDOFF_PHASES)[number]
export type MaestroCoordinatorHandoffTerminalPhase =
  | MaestroCoordinatorHandoffPhase
  | 'blocked'
  | 'outcome_unknown'

export type MaestroCoordinatorHandoffReceipt = {
  requestId: string
  runId: string
  phase: MaestroCoordinatorHandoffTerminalPhase
  predecessorLeaseId: string | null
  successorLeaseId: string
  successorTerminalHandle: string | null
  successorTabId: string | null
  successorPtyIncarnation: string | null
  capsuleDigest: string
  inputIdempotencyKey: string
  claimedGeneration: number
  expectedGraphRevision: number
  observedGraphRevision: number | null
  blockedCode: string | null
  predecessorRetained: boolean
  createdAt: string
  updatedAt: string
}

const requiredString = z.string().min(1)

export const MaestroCoordinatorHandoffParamsSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('start'),
    requestId: requiredString,
    runId: requiredString,
    from: requiredString,
    worktree: requiredString,
    capsule: z
      .string()
      .min(1)
      .max(256 * 1024),
    capsuleDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    inputIdempotencyKey: requiredString,
    expectedGraphRevision: z.number().int().nonnegative(),
    agent: z.string().refine(isTuiAgent),
    model: requiredString.optional(),
    effort: requiredString.optional(),
    timeoutMs: z.number().finite().optional(),
    retain: z.boolean().optional(),
    rolloverReason: z
      .enum(['context_rollover', 'correction_exit', 'launch_profile_drift'])
      .optional()
  }),
  z.object({
    operation: z.literal('claim'),
    requestId: requiredString,
    from: requiredString,
    view: AgentGraphViewSchema
  }),
  z.object({ operation: z.literal('show'), requestId: requiredString })
])

export function handoffPhaseIndex(phase: MaestroCoordinatorHandoffPhase): number {
  return MAESTRO_COORDINATOR_HANDOFF_PHASES.indexOf(phase)
}

export function canAdvanceCoordinatorHandoff(
  from: MaestroCoordinatorHandoffTerminalPhase,
  to: MaestroCoordinatorHandoffTerminalPhase
): boolean {
  if (from === to) {
    return true
  }
  if (from === 'blocked' || from === 'outcome_unknown') {
    return false
  }
  if (to === 'blocked' || to === 'outcome_unknown') {
    return true
  }
  return handoffPhaseIndex(to) === handoffPhaseIndex(from) + 1
}
import { z } from 'zod'
import { AgentGraphViewSchema } from './maestro-contract'
import { isTuiAgent } from './tui-agent-config'
