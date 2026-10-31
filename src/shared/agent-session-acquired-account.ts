import { z } from 'zod'
import type { AgentSessionLease, AgentSessionRecord } from './agent-session-record'
import { agentSessionScopeKey } from './agent-session-record'

const path = z
  .string()
  .min(1)
  .max(32_768)
  .refine((value) => !value.includes('\0'))
export const claudeAccountRecipeSchema = z.discriminatedUnion('route', [
  z
    .object({
      route: z.literal('managed'),
      accountId: z
        .string()
        .min(1)
        .max(512)
        .regex(/^[a-zA-Z0-9_-]+$/),
      home: path
    })
    .strict(),
  z.object({ route: z.literal('system'), home: path, configDir: path.nullable() }).strict()
])
export type ClaudeAccountRecipe = z.infer<typeof claudeAccountRecipeSchema>
const acquiredAccountSchema = z
  .object({
    version: z.literal(1),
    hostId: z.string().min(1).max(512),
    sessionId: z.string().min(1).max(512),
    scope: z.string().max(98_304),
    context: z.string().max(512).nullable(),
    fence: z.number().int().positive(),
    observedThroughFence: z.number().int().positive(),
    generation: z.string().min(1).max(512),
    spawnToken: z.string().min(1).max(512),
    recipe: claudeAccountRecipeSchema
  })
  .strict()
export type AgentSessionAcquiredAccount = z.infer<typeof acquiredAccountSchema>

/** This optional host observation never changes founding identity or saved choices. */
export function acquiredAgentSessionAccount(
  record: AgentSessionRecord,
  hostId?: string
): AgentSessionAcquiredAccount | null {
  const parsed = acquiredAccountSchema.safeParse(record.acquiredAccount)
  if (!parsed.success || record.provider !== 'claude') {
    return null
  }
  const receipt = parsed.data
  const lease = record.lease
  if (
    (hostId !== undefined && receipt.hostId !== hostId) ||
    receipt.sessionId !== record.sessionId ||
    receipt.scope !== agentSessionScopeKey(record.location) ||
    receipt.observedThroughFence !== lease.runtimeFence ||
    receipt.fence > receipt.observedThroughFence ||
    (lease.claimStatus === 'live' &&
      (receipt.fence !== lease.runtimeFence ||
        receipt.spawnToken !== lease.ownerProcess?.spawnToken))
  ) {
    return null
  }
  return receipt
}

/** Co-written with successful owner proof; a non-reporting older producer invalidates its predecessor. */
export function withAcquiredAgentSessionAccount(
  record: AgentSessionRecord,
  acquisition: { generation: string; recipe: ClaudeAccountRecipe } | undefined
): AgentSessionRecord {
  const { acquiredAccount: _previous, ...without } = record
  const process = record.lease.ownerProcess
  if (!acquisition || !process || record.provider !== 'claude') {
    return without
  }
  const acquiredAccount = acquiredAccountSchema.safeParse({
    version: 1,
    hostId: process.hostId,
    sessionId: record.sessionId,
    scope: agentSessionScopeKey(record.location),
    context: record.providerContextBoundary?.operationId ?? null,
    fence: record.lease.runtimeFence,
    observedThroughFence: record.lease.runtimeFence,
    generation: acquisition.generation,
    spawnToken: process.spawnToken,
    recipe: acquisition.recipe
  })
  return acquiredAccount.success ? { ...without, acquiredAccount: acquiredAccount.data } : without
}

/** Known lease transitions preserve the last success; older writers cannot renew this observation. */
export function acquiredAccountAcrossLease(
  record: AgentSessionRecord,
  lease: AgentSessionLease
): unknown {
  const receipt = acquiredAgentSessionAccount(record)
  return receipt ? { ...receipt, observedThroughFence: lease.runtimeFence } : record.acquiredAccount
}
