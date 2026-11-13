import * as z from 'zod'
import { structuredAgentSessionDomainFingerprint } from './lifecycle/structured-agent-session-mutation'

const advisoryFields = {
  dataScope: z.literal('published'),
  sourcePin: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxModelCalls: z.number().int().min(1).max(4),
  artifacts: z
    .array(
      z
        .object({
          path: z.string().min(1).max(512),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          text: z.string().max(1_048_576)
        })
        .strict()
    )
    .min(1)
    .max(64)
}

export const agentSessionAdvisoryPolicySchema = z
  .discriminatedUnion('schema', [
    z.object({ schema: z.literal(1), ...advisoryFields }).strict(),
    z
      .object({
        schema: z.literal(2),
        ...advisoryFields,
        binding: z
          .object({
            accountFingerprint: z.string().regex(/^claude:[a-f0-9]{64}$/),
            model: z.string().trim().min(1).max(256),
            effort: z.string().trim().min(1).max(128)
          })
          .strict()
      })
      .strict()
  ])
  .refine(
    (policy) =>
      new Set(policy.artifacts.map((artifact) => artifact.path)).size === policy.artifacts.length &&
      policy.artifacts.reduce(
        (size, artifact) => size + new TextEncoder().encode(artifact.text).byteLength,
        0
      ) <= 1_048_576
  )

export type AgentSessionAdvisoryPolicy = z.infer<typeof agentSessionAdvisoryPolicySchema>

export function agentSessionAdvisoryPolicyFingerprint(policy: AgentSessionAdvisoryPolicy): string {
  return structuredAgentSessionDomainFingerprint({
    domain:
      policy.schema === 1 ? 'agentSession.advisoryPolicy.v1' : 'agentSession.advisoryPolicy.v2',
    sessionId: '',
    fields: { policy }
  })
}
