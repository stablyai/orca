import { z } from 'zod'
import type { AgentType } from './agent-status-types'
import {
  findCatalogModel,
  getAgentSessionOptionCatalog,
  type CatalogModel
} from './agent-session-option-catalog'
import type { MaestroActor } from './maestro-contract'
import { isTuiAgent } from './tui-agent-config'
import { parseWorkspaceKey } from './workspace-scope'

export const MAESTRO_DELEGATION_PROTOCOL = 'maestro-delegation/v1' as const
export const MAESTRO_DELEGATION_SCHEMA_VERSION = 1 as const
export const MAESTRO_DELEGATION_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const
export const MAESTRO_DELEGATION_STATES = [
  'pending',
  'claimed',
  'succeeded',
  'failed',
  'rejected',
  'outcome-unknown'
] as const

const identifier = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/)
const boundedText = z.string().min(1).max(4096)
const boundedPosition = z
  .object({
    x: z.number().finite().min(-1_000_000).max(1_000_000),
    y: z.number().finite().min(-1_000_000).max(1_000_000)
  })
  .strict()

export const MaestroDelegationSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('task'), task_id: identifier }).strict(),
  z.object({ kind: z.literal('attempt'), attempt_id: identifier }).strict(),
  z.object({ kind: z.literal('note'), note_id: identifier, revision: identifier }).strict(),
  z.object({ kind: z.literal('canvas-point'), position: boundedPosition }).strict()
])

export const MaestroDelegationPlacementSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('current-workspace') }).strict(),
  z
    .object({
      kind: z.literal('existing-workspace'),
      execution_host_id: boundedText,
      workspace_key: boundedText
    })
    .strict(),
  z
    .object({
      kind: z.literal('create-child-worktree'),
      execution_host_id: boundedText,
      parent_workspace_key: boundedText,
      name_hint: identifier
    })
    .strict()
])

const requestedProfileShape = z
  .object({
    lane: boundedText,
    agent: boundedText.nullable(),
    model: boundedText.nullable(),
    effort: z.enum(MAESTRO_DELEGATION_EFFORTS).nullable()
  })
  .strict()

export const MaestroDelegationRequestSchema = z
  .object({
    schema_version: z.literal(MAESTRO_DELEGATION_SCHEMA_VERSION),
    protocol: z.literal(MAESTRO_DELEGATION_PROTOCOL),
    intent_id: identifier,
    workspace: z
      .object({
        repository_id: identifier,
        execution_host_id: boundedText,
        workspace_key: boundedText.refine(
          (value) => parseWorkspaceKey(value) !== null,
          'Workspace key must be an Orca workspace key.'
        ),
        run_id: identifier
      })
      .strict(),
    source: MaestroDelegationSourceSchema,
    parent_task_id: identifier.nullable(),
    parent_attempt_id: identifier.nullable(),
    purpose: boundedText,
    role: identifier,
    requested: requestedProfileShape,
    placement_request: MaestroDelegationPlacementSchema,
    context_refs: z.array(identifier).max(256),
    paths: z.array(z.string().min(1).max(4096)).min(1).max(256),
    check: z.string().min(1).max(8192)
  })
  .strict()

const resolvedPlacementShape = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('current-workspace'),
      execution_host_id: boundedText,
      workspace_key: boundedText
    })
    .strict(),
  z
    .object({
      kind: z.literal('existing-workspace'),
      execution_host_id: boundedText,
      workspace_key: boundedText
    })
    .strict(),
  z
    .object({
      kind: z.literal('create-child-worktree'),
      execution_host_id: boundedText,
      parent_workspace_key: boundedText,
      name_hint: identifier
    })
    .strict()
])

export const MaestroDelegationPermissionModeSchema = z.enum(['yolo', 'manual', 'mixed'])

export const MaestroDelegationResolvedProfileSchema = z
  .object({
    agent: boundedText.nullable(),
    model: boundedText.nullable(),
    effort: z.enum(MAESTRO_DELEGATION_EFFORTS).nullable(),
    permission_mode: MaestroDelegationPermissionModeSchema,
    placement: resolvedPlacementShape
  })
  .strict()

export const MaestroDelegationIntentSchema = MaestroDelegationRequestSchema.extend({
  actor: z
    .object({
      actor_id: identifier,
      kind: z.enum(['user', 'coordinator', 'worker', 'system']),
      authenticated: z.literal(true),
      session_id: identifier
    })
    .strict(),
  coordinator_generation: z.number().int().min(1),
  resolved: MaestroDelegationResolvedProfileSchema,
  state: z.enum(MAESTRO_DELEGATION_STATES),
  spawned_by: identifier.nullable()
})

export const MaestroDelegationWorkerSchema = z
  .object({
    dispatch_id: identifier,
    terminal_id: identifier,
    tracked: z.literal(true)
  })
  .strict()

export const MaestroDelegationSettlementSchema = z.discriminatedUnion('outcome', [
  z
    .object({
      outcome: z.literal('succeeded'),
      worker: MaestroDelegationWorkerSchema,
      detail: boundedText.nullable()
    })
    .strict(),
  z.object({ outcome: z.literal('failed'), detail: boundedText }).strict(),
  z.object({ outcome: z.literal('rejected'), detail: boundedText }).strict(),
  z.object({ outcome: z.literal('outcome-unknown'), detail: boundedText }).strict()
])

export const MaestroDelegationCatalogSchema = z
  .object({
    agents: z.array(
      z
        .object({
          id: boundedText,
          label: boundedText,
          enabled: z.boolean(),
          disabled_reason: boundedText.nullable(),
          models: z.array(
            z
              .object({
                id: boundedText,
                label: boundedText,
                efforts: z.array(z.enum(MAESTRO_DELEGATION_EFFORTS))
              })
              .strict()
          ),
          permission_mode: MaestroDelegationPermissionModeSchema
        })
        .strict()
    ),
    permission_mode: z
      .object({
        value: MaestroDelegationPermissionModeSchema,
        display_only: z.literal(true),
        reason: boundedText
      })
      .strict(),
    placements: z.array(
      z
        .object({
          placement: MaestroDelegationPlacementSchema,
          label: boundedText,
          enabled: z.boolean(),
          disabled_reason: boundedText.nullable()
        })
        .strict()
    )
  })
  .strict()

export type MaestroDelegationSource = z.infer<typeof MaestroDelegationSourceSchema>
export type MaestroDelegationPlacement = z.infer<typeof MaestroDelegationPlacementSchema>
export type MaestroDelegationRequest = z.infer<typeof MaestroDelegationRequestSchema>
export type MaestroDelegationResolvedProfile = z.infer<
  typeof MaestroDelegationResolvedProfileSchema
>
export type MaestroDelegationIntent = z.infer<typeof MaestroDelegationIntentSchema>
export type MaestroDelegationSettlement = z.infer<typeof MaestroDelegationSettlementSchema>
export type MaestroDelegationCatalog = z.infer<typeof MaestroDelegationCatalogSchema>
export type MaestroDelegationState = (typeof MAESTRO_DELEGATION_STATES)[number]
export type MaestroDelegationPermissionMode = z.infer<typeof MaestroDelegationPermissionModeSchema>

export function parseMaestroDelegationRequest(value: unknown): MaestroDelegationRequest {
  return MaestroDelegationRequestSchema.parse(value)
}

export function parseMaestroDelegationIntent(value: unknown): MaestroDelegationIntent {
  return MaestroDelegationIntentSchema.parse(value)
}

export function parseMaestroDelegationSettlement(value: unknown): MaestroDelegationSettlement {
  return MaestroDelegationSettlementSchema.parse(value)
}

export function resolveMaestroDelegationProfile(args: {
  requested: MaestroDelegationRequest['requested']
  placement: MaestroDelegationPlacement
  permissionMode: MaestroDelegationPermissionMode
  currentWorkspace?: { execution_host_id: string; workspace_key: string }
}): MaestroDelegationResolvedProfile {
  const agent =
    args.requested.agent && isTuiAgent(args.requested.agent) ? args.requested.agent : null
  const catalog = agent ? getAgentSessionOptionCatalog(agent as AgentType) : null
  const model =
    agent && args.requested.model && catalog && findCatalogModel(catalog, args.requested.model)
      ? args.requested.model
      : null
  const modelCatalog = model && catalog ? findCatalogModel(catalog, model) : undefined
  const effort =
    modelCatalog && args.requested.effort && supportsEffort(modelCatalog, args.requested.effort)
      ? args.requested.effort
      : null
  return {
    agent,
    model,
    effort,
    permission_mode: args.permissionMode,
    placement: resolvePlacement(args.placement, args.currentWorkspace)
  }
}

function supportsEffort(
  model: CatalogModel,
  effort: (typeof MAESTRO_DELEGATION_EFFORTS)[number]
): boolean {
  const option = model.options.find((candidate) => candidate.id === 'effort')
  return (
    option?.kind.type === 'select' && option.kind.choices.some((choice) => choice.value === effort)
  )
}

function resolvePlacement(
  placement: MaestroDelegationPlacement,
  currentWorkspace?: { execution_host_id: string; workspace_key: string }
): MaestroDelegationResolvedProfile['placement'] {
  if (placement.kind === 'current-workspace') {
    if (!currentWorkspace) {
      throw new Error('current_workspace_unavailable')
    }
    return {
      kind: 'current-workspace',
      execution_host_id: currentWorkspace.execution_host_id,
      workspace_key: currentWorkspace.workspace_key
    }
  }
  return placement
}

export type MaestroDelegationServerFields = {
  actor: MaestroActor
  coordinatorGeneration: number
  resolved: MaestroDelegationResolvedProfile
  state: MaestroDelegationState
  spawnedBy: string | null
}

export function buildMaestroDelegationIntent(
  request: MaestroDelegationRequest,
  fields: MaestroDelegationServerFields
): MaestroDelegationIntent {
  return {
    ...request,
    actor: fields.actor,
    coordinator_generation: fields.coordinatorGeneration,
    resolved: fields.resolved,
    state: fields.state,
    spawned_by: fields.spawnedBy
  }
}
