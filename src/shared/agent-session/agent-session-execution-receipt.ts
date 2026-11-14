import { z } from 'zod'
import { agentSessionExecutionEvidenceSchema } from './agent-session-execution-evidence'
import { agentSessionExecutionReportSchema } from './agent-session-execution-report'
export const agentSessionExecutionReceiptSchema = z
  .object({
    version: z.literal(1),
    runtime: z
      .object({
        runtimeId: z.string().min(1).max(256),
        pid: z.number().int().positive(),
        buildHash: z.string().regex(/^[a-f0-9]{16}$/)
      })
      .strict()
      .optional(),
    spawnTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    execution: agentSessionExecutionEvidenceSchema,
    invalidated: z.boolean(),
    turnCompleted: z.boolean(),
    report: agentSessionExecutionReportSchema.optional(),
    closure: z
      .object({
        root: z.enum(['exited', 'unverifiable']),
        tree: z.enum(['exited', 'unverifiable']),
        observedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      })
      .strict()
      .optional()
  })
  .strict()
export type AgentSessionExecutionReceipt = z.infer<typeof agentSessionExecutionReceiptSchema>
export type AgentSessionExecutionReceiptWrite = {
  sessionId: string
  fence: number
  generation: string
  spawnToken: string
  receipt: AgentSessionExecutionReceipt
}
