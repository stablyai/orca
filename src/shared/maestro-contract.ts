import { z } from 'zod'
import { MaestroRunProgressSummarySchema } from './maestro-run-progress'
export {
  AGENT_GRAPH_VIEW_PROTOCOL,
  DELEGATION_INTENT_PROTOCOL,
  MAESTRO_MUTATION_PROTOCOL,
  MAESTRO_PROTOCOL_VERSION
} from './maestro-identity-contract'
import {
  AGENT_GRAPH_VIEW_PROTOCOL,
  MAESTRO_MUTATION_PROTOCOL,
  MAESTRO_PROTOCOL_VERSION,
  MaestroActorSchema,
  MaestroDocumentReadScopeSchema,
  MaestroWorkspaceAnchorSchema
} from './maestro-identity-contract'
export const MAX_MAESTRO_DOCUMENT_BYTES = 512 * 1024
export const MAX_MAESTRO_DELTAS = 128
export const MAX_MAESTRO_LAYOUT_COORDINATE = 1_000_000
export const MIN_MAESTRO_LAYOUT_ZOOM = 0.025
export const MAX_MAESTRO_LAYOUT_ZOOM = 4
const identifier = z.string().regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/)
const opaqueKey = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.split('').every((character) => character.charCodeAt(0) >= 32))
const boundedLayoutCoordinate = z
  .number()
  .finite()
  .min(-MAX_MAESTRO_LAYOUT_COORDINATE)
  .max(MAX_MAESTRO_LAYOUT_COORDINATE)
const boundedLayoutPosition = z
  .object({ x: boundedLayoutCoordinate, y: boundedLayoutCoordinate })
  .strict()
const position = boundedLayoutPosition
const FORBIDDEN_BROWSER_PROJECTION_FIELDS = new Set([
  'cookie',
  'cookies',
  'authorization',
  'authorization_data',
  'dom',
  'complete_dom',
  'accessibility_tree',
  'image_bytes',
  'data'
])

function containsForbiddenBrowserProjectionField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenBrowserProjectionField)
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return Object.entries(value).some(
    ([key, child]) =>
      FORBIDDEN_BROWSER_PROJECTION_FIELDS.has(key.toLowerCase()) ||
      containsForbiddenBrowserProjectionField(child)
  )
}
export {
  MaestroActorSchema,
  MaestroDocumentReadScopeSchema,
  MaestroWorkspaceAnchorSchema
} from './maestro-identity-contract'
export const MaestroContextSnapshotSchema = z
  .object({
    note_id: identifier,
    revision: identifier,
    content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    media_type: z.literal('text/markdown'),
    title: z.string().min(1).max(512),
    snapshot_path: z.string().min(1).max(4096),
    byte_count: z
      .number()
      .int()
      .min(0)
      .max(64 * 1024)
  })
  .strict()
const workspaceScope = z
  .object({
    schema_version: z.literal(1),
    repository_id: identifier,
    canonical_root: z.string().min(1),
    execution_host: z.object({ id: opaqueKey, boundary: z.enum(['local', 'remote']) }).strict(),
    orchestration_home: z
      .object({
        execution_host_id: opaqueKey,
        workspace_key: opaqueKey,
        kind: z.enum(['folder', 'git-worktree']),
        path: z.string().min(1),
        worktree_path: z.string().min(1).optional()
      })
      .strict(),
    execution_workspace: z
      .object({
        execution_host_id: opaqueKey,
        workspace_key: opaqueKey,
        kind: z.enum(['folder', 'git-worktree']),
        path: z.string().min(1),
        worktree_path: z.string().min(1).optional()
      })
      .strict(),
    base_revision: z.string().min(1),
    dirty_paths: z.array(z.string().min(1)).max(1024),
    run_id: identifier,
    coordinator_generation: z.number().int().min(1),
    binding_receipt_ref: z.string().regex(/^artifact:.+/),
    binding_receipt_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/)
  })
  .strict()

const graphNode = z
  .object({
    id: identifier,
    type: z.enum([
      'task',
      'attempt',
      'note-reference',
      'terminal-receipt',
      'browser-surface',
      'evidence',
      'cleanup',
      'portal'
    ]),
    status: z.string().min(1).max(64),
    summary: z.string().min(1).max(2048),
    task_id: identifier.optional(),
    attempt_id: identifier.optional(),
    blockers: z.array(identifier).max(64).optional(),
    position: position.optional(),
    snapshot: MaestroContextSnapshotSchema.optional(),
    profile: z.record(z.string(), z.unknown()).optional(),
    resource: z.record(z.string(), z.unknown()).optional()
  })
  .strict()
  .superRefine((node, context) => {
    if (node.type !== 'browser-surface') {
      return
    }
    if (!node.resource || containsForbiddenBrowserProjectionField(node.resource)) {
      context.addIssue({
        code: 'custom',
        message: 'Browser-surface nodes require bounded metadata without page secrets or bytes.',
        path: ['resource']
      })
    }
  })

const AgentGraphViewInputSchema = z
  .object({
    schema_version: z.literal(MAESTRO_PROTOCOL_VERSION),
    protocol: z.literal(AGENT_GRAPH_VIEW_PROTOCOL),
    kind: z.enum(['snapshot', 'delta']),
    workspace_scope: workspaceScope,
    change: identifier,
    run_id: identifier,
    coordinator: z.object({ id: identifier, generation: z.number().int().min(1) }).strict(),
    capabilities: z
      .object({
        agents: z.array(z.string().min(1)).max(32),
        efforts: z.array(z.enum(['low', 'medium', 'high', 'xhigh'])).max(4),
        placement_kinds: z
          .array(z.enum(['current-workspace', 'existing-workspace', 'create-child-worktree']))
          .max(3),
        watch_deltas: z.boolean()
      })
      .strict(),
    nodes: z.array(graphNode).max(1000),
    edges: z
      .array(
        z
          .object({
            id: identifier,
            type: z.enum([
              'depends_on',
              'context_for',
              'spawned_by',
              'executes',
              'opens',
              'validates',
              'captured_as',
              'reports_to',
              'produces',
              'portals_to'
            ]),
            source_id: identifier,
            target_id: identifier
          })
          .strict()
      )
      .max(3000),
    removed_node_ids: z.array(identifier).max(1000),
    removed_edge_ids: z.array(identifier).max(3000),
    revision: z.number().int().min(0),
    cursor: z
      .object({
        stream_id: identifier,
        sequence: z.number().int().min(0),
        revision: z.number().int().min(0)
      })
      .strict()
      .nullable(),
    from_cursor: z
      .object({
        stream_id: identifier,
        sequence: z.number().int().min(0),
        revision: z.number().int().min(0)
      })
      .strict()
      .nullable(),
    reset_required: z.boolean(),
    progress: z.unknown().optional()
  })
  .strict()

export const AgentGraphViewSchema = AgentGraphViewInputSchema.transform((view) => {
  const progress = MaestroRunProgressSummarySchema.safeParse(view.progress)
  return {
    ...view,
    progress: progress.success ? progress.data : undefined
  }
})

export const MaestroMutationSchema = z
  .object({
    schema_version: z.literal(MAESTRO_PROTOCOL_VERSION),
    protocol: z.literal(MAESTRO_MUTATION_PROTOCOL),
    mutation_id: identifier,
    workspace: MaestroWorkspaceAnchorSchema,
    actor: MaestroActorSchema,
    coordinator_generation: z.number().int().min(1),
    expected_revision: z.number().int().min(0),
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('move-node'), node_id: identifier, position }).strict(),
      z
        .object({
          kind: z.literal('pin-note-snapshot'),
          task_id: identifier,
          snapshot: MaestroContextSnapshotSchema
        })
        .strict()
    ])
  })
  .strict()

export { DelegationIntentSchema, parseDelegationIntent } from './maestro-delegation-intent-contract'
export type { DelegationIntent } from './maestro-delegation-intent-contract'
export type MaestroWorkspaceAnchor = z.infer<typeof MaestroWorkspaceAnchorSchema>
export type MaestroDocumentReadScope = z.infer<typeof MaestroDocumentReadScopeSchema>
export type MaestroContextSnapshot = z.infer<typeof MaestroContextSnapshotSchema>
export type MaestroActor = z.infer<typeof MaestroActorSchema>
export type AgentGraphView = z.infer<typeof AgentGraphViewSchema>
export type MaestroMutation = z.infer<typeof MaestroMutationSchema>

export {
  MaestroDocumentAuthoringMutationSchema,
  MaestroDocumentLayoutMutationSchema,
  MaestroDocumentSchema
} from './maestro-document-contract'
export {
  parseMaestroDocumentAuthoringMutation,
  parseMaestroDocumentLayoutMutation
} from './maestro-document-runtime-contract'
export type {
  MaestroAuthoringEdgePayload,
  MaestroDocument,
  MaestroDocumentAuthoringMutation,
  MaestroDocumentAuthoringScope,
  MaestroDocumentEdge,
  MaestroDocumentNode,
  MaestroEdgeDirection,
  MaestroEdgeType,
  MaestroNoteSnapshotPayload
} from './maestro-document-contract'
export type {
  MaestroDocumentInput,
  MaestroDocumentLayoutMutation,
  MaestroDocumentNodeInput,
  MaestroDocumentReadResult
} from './maestro-document-runtime-contract'

export function parseAgentGraphView(value: unknown): AgentGraphView {
  return AgentGraphViewSchema.parse(value)
}

export function parseMaestroMutation(value: unknown): MaestroMutation {
  return MaestroMutationSchema.parse(value)
}

export function parseMaestroDocumentReadScope(value: unknown): MaestroDocumentReadScope {
  return MaestroDocumentReadScopeSchema.parse(value)
}
