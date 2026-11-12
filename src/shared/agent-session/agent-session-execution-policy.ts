import * as z from 'zod'
import { structuredAgentSessionDomainFingerprint } from './lifecycle/structured-agent-session-mutation'

const selection = z
  .string()
  .min(1)
  .max(512)
  .refine((value) =>
    [...value].every((char) => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127)
  )

export const agentSessionExecutionPolicySchema = z
  .object({
    schema: z.literal(1),
    sourcePin: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
    accountFingerprint: z.string().regex(/^codex:[a-f0-9]{64}$/),
    model: selection,
    effort: selection,
    deadlineAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    access: z.enum(['read-only', 'workspace'])
  })
  .strict()

export type AgentSessionExecutionPolicy = z.infer<typeof agentSessionExecutionPolicySchema>

export function agentSessionExecutionPolicyFingerprint(
  policy: AgentSessionExecutionPolicy
): string {
  return structuredAgentSessionDomainFingerprint({
    domain: 'agentSession.executionPolicy.v1',
    sessionId: '',
    fields: { policy }
  })
}
