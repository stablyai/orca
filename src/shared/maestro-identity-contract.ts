import { z } from 'zod'
import { parseWorkspaceKey } from './workspace-scope'

/** Identity and protocol primitives every Maestro contract shares, free of protocol imports. */
export const MAESTRO_PROTOCOL_VERSION = 1 as const
export const AGENT_GRAPH_VIEW_PROTOCOL = 'agent-graph-view/v1' as const
export const MAESTRO_MUTATION_PROTOCOL = 'maestro-mutation/v1' as const
export const DELEGATION_INTENT_PROTOCOL = 'delegation-intent/v1' as const

export const maestroIdentifier = z.string().regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/)
export const maestroOpaqueKey = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.split('').every((character) => character.charCodeAt(0) >= 32))

const identifier = maestroIdentifier
const opaqueKey = maestroOpaqueKey

export const MaestroWorkspaceAnchorSchema = z
  .object({
    repository_id: identifier,
    execution_host_id: opaqueKey,
    workspace_key: opaqueKey.refine((value) => parseWorkspaceKey(value) !== null, {
      message: 'Workspace key must be an Orca public workspace key.'
    }),
    run_id: identifier
  })
  .strict()
export const MaestroDocumentReadScopeSchema = z
  .object({
    execution_host_id: opaqueKey,
    workspace_key: opaqueKey.refine((value) => parseWorkspaceKey(value) !== null, {
      message: 'Workspace key must be an Orca public workspace key.'
    })
  })
  .strict()
export const MaestroActorSchema = z
  .object({
    actor_id: identifier,
    kind: z.enum(['user', 'coordinator', 'worker', 'system']),
    authenticated: z.literal(true),
    session_id: identifier
  })
  .strict()
