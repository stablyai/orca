import { z } from 'zod'

const text = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      value === value.trim() &&
      ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const paths = z.array(text).max(64)
export const agentSessionExecutionUsageSchema = z
  .object({
    threadId: text,
    observedAt: count,
    totalTokens: count,
    inputTokens: count,
    cachedInputTokens: count,
    outputTokens: count,
    reasoningOutputTokens: count
  })
  .strict()
export type AgentSessionExecutionUsage = z.infer<typeof agentSessionExecutionUsageSchema>

export const agentSessionExecutionExecutableSchema = z
  .object({
    path: text,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    version: text
  })
  .strict()
export type AgentSessionExecutionExecutable = z.infer<typeof agentSessionExecutionExecutableSchema>

/** Native facts about one held child; evidence alone does not qualify a route. */
export const agentSessionExecutionEvidenceSchema = z
  .object({
    version: z.literal(1),
    agent: z.literal('codex'),
    modelProvider: z.literal('openai'),
    sessionId: text,
    runtimeFence: count.positive(),
    acquisitionGeneration: text,
    observedAt: count,
    cwd: text,
    runtimeWorkspaceRoots: paths.optional(),
    model: text,
    effort: text,
    executable: agentSessionExecutionExecutableSchema.optional(),
    usage: agentSessionExecutionUsageSchema.optional(),
    bounded: z
      .object({
        policyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        deadlineAt: count.positive(),
        toolsIsolated: z.boolean(),
        inputAdmitted: z.boolean(),
        workspaceRootsSource: z.literal('thread-open')
      })
      .strict()
      .optional(),
    account: z
      .object({
        type: z.literal('chatgpt'),
        fingerprint: z.string().regex(/^codex:[a-f0-9]{64}$/),
        plan: text
      })
      .strict(),
    permissions: z
      .object({
        activeProfile: z.object({ id: text }).strict().optional(),
        approvalPolicy: text,
        approvalsReviewer: text,
        sandbox: z
          .object({
            type: z.enum(['readOnly', 'workspaceWrite']),
            networkAccess: z.literal(false),
            readableRoots: paths.optional(),
            writableRoots: paths.optional(),
            includePlatformDefaults: z.boolean().optional()
          })
          .strict()
      })
      .strict()
  })
  .strict()
export type AgentSessionExecutionEvidence = z.infer<typeof agentSessionExecutionEvidenceSchema>
