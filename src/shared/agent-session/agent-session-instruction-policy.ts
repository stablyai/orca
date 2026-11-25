import { z } from 'zod'

export type AgentSessionInstructionBaseline = {
  soul: string | null
  memory: string | null
  skills: string | null
}

export function sameInstructionBaseline(
  left: AgentSessionInstructionBaseline | undefined,
  right: AgentSessionInstructionBaseline | undefined
): boolean {
  return (
    left === right ||
    (!!left &&
      !!right &&
      left.soul === right.soul &&
      left.memory === right.memory &&
      left.skills === right.skills)
  )
}

export type AgentSessionInstructionPolicy = {
  version: 1
  botId: string
  standing: string
  snapshot: string
  scope: string
  nativeId: string
  operationId: string
  generation: string
  anchor: string
  fence: number
  state: 'pending' | 'delivered' | 'released'
  baseline?: AgentSessionInstructionBaseline
}

const bounded = z.string().min(1).max(512)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const policySchema = z.object({
  version: z.literal(1),
  botId: bounded,
  standing: digest,
  snapshot: digest,
  scope: digest,
  nativeId: bounded,
  operationId: bounded,
  generation: bounded,
  anchor: bounded,
  fence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  state: z.enum(['pending', 'delivered', 'released']),
  baseline: z
    .object({
      soul: digest.nullable(),
      memory: digest.nullable(),
      skills: digest.nullable()
    })
    .optional()
})

export function readAgentSessionInstructionPolicy(
  value: unknown
): AgentSessionInstructionPolicy | undefined {
  const parsed = policySchema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}
