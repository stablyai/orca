import { z } from 'zod'
import {
  DELEGATION_INTENT_PROTOCOL,
  MAESTRO_PROTOCOL_VERSION,
  MaestroActorSchema,
  MaestroWorkspaceAnchorSchema
} from './maestro-identity-contract'

const identifier = z.string().regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/)
const opaqueKey = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.split('').every((character) => character.charCodeAt(0) >= 32))

const placementRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current-workspace') }).strict(),
  z
    .object({
      kind: z.literal('existing-workspace'),
      execution_host_id: opaqueKey,
      workspace_key: opaqueKey
    })
    .strict(),
  z
    .object({
      kind: z.literal('create-child-worktree'),
      execution_host_id: opaqueKey,
      parent_workspace_key: opaqueKey,
      name_hint: identifier
    })
    .strict()
])

export const DelegationIntentSchema = z
  .object({
    schema_version: z.literal(MAESTRO_PROTOCOL_VERSION),
    protocol: z.literal(DELEGATION_INTENT_PROTOCOL),
    intent_id: identifier,
    workspace: MaestroWorkspaceAnchorSchema,
    actor: MaestroActorSchema,
    coordinator_generation: z.number().int().min(1),
    expected_revision: z.number().int().min(0),
    parent_task_id: identifier,
    parent_attempt_id: identifier,
    purpose: z.string().min(1).max(2048),
    role: identifier,
    requested: z
      .object({
        lane: z.string().min(1),
        agent: z.string().min(1).nullable(),
        model: z.string().min(1).nullable(),
        effort: z.enum(['low', 'medium', 'high', 'xhigh']).nullable()
      })
      .strict(),
    placement_request: placementRequest,
    context_refs: z.array(identifier).max(256),
    paths: z.array(z.string().min(1).max(4096)).min(1).max(256),
    check: z.string().min(1).max(8192)
  })
  .strict()

export type DelegationIntent = z.infer<typeof DelegationIntentSchema>

export function parseDelegationIntent(value: unknown): DelegationIntent {
  return DelegationIntentSchema.parse(value)
}
