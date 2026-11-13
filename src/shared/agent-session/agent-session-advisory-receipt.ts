import { z } from 'zod'
import { agentSessionExecutionExecutableSchema } from './agent-session-execution-evidence'

const text = z.string().min(1).max(512)
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const tokens = z
  .object({
    model: text,
    inputTokens: count,
    outputTokens: count,
    cacheReadInputTokens: count,
    cacheCreationInputTokens: count,
    thinkingTokens: count.optional()
  })
  .strict()
  .refine(
    (value) => value.thinkingTokens === undefined || value.thinkingTokens <= value.outputTokens
  )

export const agentSessionAdvisoryUsageSchema = z
  .object({
    scope: z.literal('query-pipeline'),
    auxiliaryCoverage: z.literal('partial'),
    observedAt: count,
    models: z.array(tokens).max(64)
  })
  .strict()

export const agentSessionAdvisoryReceiptSchema = z
  .object({
    version: z.literal(1),
    spawnTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
    runtime: z
      .object({
        runtimeId: text,
        pid: count.positive(),
        buildHash: z.string().regex(/^[a-f0-9]{16}$/)
      })
      .strict()
      .optional(),
    execution: z
      .object({
        agent: z.literal('claude'),
        sessionId: text,
        runtimeFence: count.positive(),
        acquisitionGeneration: text,
        observedAt: count,
        binding: z
          .object({
            accountFingerprint: z.string().regex(/^claude:[a-f0-9]{64}$/),
            plan: z.enum(['pro', 'max']),
            model: text,
            effort: text
          })
          .strict()
          .nullable(),
        responseModel: text.nullable().optional(),
        executable: agentSessionExecutionExecutableSchema.optional(),
        bounded: z
          .object({
            policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            deadlineAt: count.positive(),
            maxModelCalls: count.min(1).max(4),
            modelCalls: count,
            inputAdmitted: z.boolean(),
            hooksApplied: z.boolean(),
            callCounter: z.literal('main-assistant-message-ids')
          })
          .strict(),
        usage: agentSessionAdvisoryUsageSchema.optional()
      })
      .strict(),
    invalidated: z.boolean(),
    turnCompleted: z.boolean(),
    closure: z
      .object({
        root: z.enum(['exited', 'unverifiable']),
        tree: z.enum(['exited', 'unverifiable']),
        observedAt: count
      })
      .strict()
      .optional()
  })
  .strict()

export type AgentSessionAdvisoryReceipt = z.infer<typeof agentSessionAdvisoryReceiptSchema>
export type AgentSessionAdvisoryReceiptWrite = {
  sessionId: string
  fence: number
  generation: string
  spawnToken: string
  receipt: AgentSessionAdvisoryReceipt
}
export type AgentSessionAdvisoryObservation = Omit<
  AgentSessionAdvisoryReceipt,
  'runtime' | 'spawnTokenHash' | 'execution'
> & {
  execution: Omit<
    AgentSessionAdvisoryReceipt['execution'],
    'sessionId' | 'runtimeFence' | 'acquisitionGeneration'
  >
}
