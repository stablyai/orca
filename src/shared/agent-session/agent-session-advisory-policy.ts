import * as z from 'zod'
import { structuredAgentSessionDomainFingerprint } from './lifecycle/structured-agent-session-mutation'

export const agentSessionAdvisoryPolicySchema = z
  .object({
    schema: z.literal(1),
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
  })
  .strict()
  .refine(
    (policy) =>
      new Set(policy.artifacts.map((artifact) => artifact.path)).size === policy.artifacts.length &&
      policy.artifacts.reduce((size, artifact) => size + artifact.text.length, 0) <= 1_048_576
  )

export type AgentSessionAdvisoryPolicy = z.infer<typeof agentSessionAdvisoryPolicySchema>

export function agentSessionAdvisoryPolicyFingerprint(policy: AgentSessionAdvisoryPolicy): string {
  return structuredAgentSessionDomainFingerprint({
    domain: 'agentSession.advisoryPolicy.v1',
    sessionId: '',
    fields: { policy }
  })
}
