import { z } from 'zod'
import { parseWorkspaceKey } from './workspace-scope'

const MAESTRO_PROTOCOL_VERSION = 1 as const
const MAESTRO_DOCUMENT_LAYOUT_MUTATION_PROTOCOL = 'maestro-document-layout-mutation/v1' as const
const MAESTRO_DOCUMENT_AUTHORING_MUTATION_PROTOCOL =
  'maestro-document-authoring-mutation/v1' as const
const MAX_MAESTRO_DELTAS = 128
const MAX_MAESTRO_LAYOUT_COORDINATE = 1_000_000
const MIN_MAESTRO_LAYOUT_ZOOM = 0.025
const MAX_MAESTRO_LAYOUT_ZOOM = 4

const identifier = z.string().regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/)
const opaqueKey = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.split('').every((character) => character.charCodeAt(0) >= 32))
const MaestroDocumentReadScopeSchema = z
  .object({
    execution_host_id: opaqueKey,
    workspace_key: opaqueKey.refine((value) => parseWorkspaceKey(value) !== null, {
      message: 'Workspace key must be an Orca public workspace key.'
    })
  })
  .strict()
const MaestroDocumentAuthoringScopeSchema = MaestroDocumentReadScopeSchema.extend({
  repository_id: identifier,
  run_id: identifier
}).strict()
const boundedLayoutCoordinate = z
  .number()
  .finite()
  .min(-MAX_MAESTRO_LAYOUT_COORDINATE)
  .max(MAX_MAESTRO_LAYOUT_COORDINATE)
const boundedLayoutPosition = z
  .object({ x: boundedLayoutCoordinate, y: boundedLayoutCoordinate })
  .strict()
const boundedViewport = z
  .object({
    center: boundedLayoutPosition,
    zoom: z.number().finite().min(MIN_MAESTRO_LAYOUT_ZOOM).max(MAX_MAESTRO_LAYOUT_ZOOM)
  })
  .strict()
const boundedNoteMarkdown = z
  .string()
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= 64 * 1024,
    'Maestro note exceeds its bounded capacity.'
  )
const storedDocumentNode = z
  .object({
    position: boundedLayoutPosition.optional(),
    kind: z.enum(['layout', 'note']).optional(),
    title: z.string().min(1).max(512).optional(),
    markdown: boundedNoteMarkdown.optional(),
    note_revision: z.number().int().min(1).max(1_000_000).optional(),
    context_snapshot_id: identifier.optional()
  })
  .strict()
  .refine(
    (node) =>
      node.kind !== 'note' ||
      Boolean(node.title && node.markdown !== undefined && node.note_revision),
    'Note nodes need bounded note data.'
  )

const maestroEdgeType = z.enum([
  'depends_on',
  'context_for',
  'spawned_by',
  'executes',
  'reports_to',
  'produces',
  'portals_to'
])
const maestroEdgeDirection = z.enum(['forward', 'reverse', 'bidirectional'])
const storedUserEdge = z
  .object({
    id: identifier,
    source_id: identifier,
    target_id: identifier,
    type: maestroEdgeType,
    direction: maestroEdgeDirection,
    projected: z.literal(false),
    context_snapshot_id: identifier.optional(),
    context_note_id: identifier.optional()
  })
  .refine((edge) => edge.source_id !== edge.target_id, 'Maestro edges need two endpoints.')
  .refine(
    (edge) =>
      edge.type !== 'context_for' || Boolean(edge.context_snapshot_id && edge.context_note_id),
    'Context links need a pinned note snapshot.'
  )
  .refine(
    (edge) =>
      edge.type !== 'context_for' ||
      edge.context_note_id === edge.source_id ||
      edge.context_note_id === edge.target_id,
    'Context snapshot must belong to an edge endpoint.'
  )
const authoringHistory = z
  .object({
    undo_stack: z.array(identifier).max(MAX_MAESTRO_DELTAS),
    redo_stack: z.array(identifier).max(MAX_MAESTRO_DELTAS)
  })
  .strict()

export const MaestroDocumentSchema = z
  .object({
    nodes: z
      .record(z.string(), storedDocumentNode)
      .refine((nodes) => Object.keys(nodes).length <= 1000, 'Maestro document has too many nodes.'),
    edges: z.array(storedUserEdge).max(3000).default([]),
    authoring_history: authoringHistory.default({ undo_stack: [], redo_stack: [] }),
    viewport: boundedViewport.optional()
  })
  .strict()

export const MaestroDocumentLayoutMutationSchema = z
  .object({
    schema_version: z.literal(MAESTRO_PROTOCOL_VERSION),
    protocol: z.literal(MAESTRO_DOCUMENT_LAYOUT_MUTATION_PROTOCOL),
    mutation_id: identifier,
    scope: MaestroDocumentReadScopeSchema,
    expected_revision: z.number().int().min(0),
    operation: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('move-node'),
          node_id: identifier,
          position: boundedLayoutPosition
        })
        .strict(),
      z.object({ kind: z.literal('set-viewport'), viewport: boundedViewport }).strict()
    ])
  })
  .strict()

const authoringNotePayload = z
  .object({
    node_id: identifier,
    position: boundedLayoutPosition,
    title: z.string().min(1).max(512),
    markdown: boundedNoteMarkdown
  })
  .strict()
const authoringEdgePayload = z
  .object({
    id: identifier,
    source_id: identifier,
    target_id: identifier,
    type: maestroEdgeType,
    direction: maestroEdgeDirection,
    context_note_id: identifier.optional(),
    expected_note_revision: z.number().int().min(1).optional()
  })
  .strict()
  .refine((edge) => edge.source_id !== edge.target_id, 'Maestro edges need two endpoints.')
  .refine(
    (edge) =>
      edge.type !== 'context_for' || Boolean(edge.context_note_id && edge.expected_note_revision),
    'Context links need a note revision.'
  )

export const MaestroDocumentAuthoringMutationSchema = z
  .object({
    schema_version: z.literal(MAESTRO_PROTOCOL_VERSION),
    protocol: z.literal(MAESTRO_DOCUMENT_AUTHORING_MUTATION_PROTOCOL),
    mutation_id: identifier,
    scope: MaestroDocumentAuthoringScopeSchema,
    expected_revision: z.number().int().min(0),
    operation: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('create-note'), ...authoringNotePayload.shape }).strict(),
      z
        .object({
          kind: z.literal('update-note'),
          node_id: identifier,
          expected_note_revision: z.number().int().min(1),
          title: z.string().min(1).max(512),
          markdown: boundedNoteMarkdown
        })
        .strict(),
      z.object({ kind: z.literal('create-edge'), ...authoringEdgePayload.shape }).strict(),
      z.object({ kind: z.literal('delete-edge'), edge_id: identifier }).strict(),
      z.object({ kind: z.literal('undo'), target_mutation_id: identifier }).strict(),
      z.object({ kind: z.literal('redo'), target_mutation_id: identifier }).strict()
    ])
  })
  .strict()

export type MaestroDocument = z.infer<typeof MaestroDocumentSchema>
export type MaestroDocumentAuthoringMutation = z.infer<
  typeof MaestroDocumentAuthoringMutationSchema
>
export type MaestroDocumentAuthoringScope = z.infer<typeof MaestroDocumentAuthoringScopeSchema>
export type MaestroDocumentNode = MaestroDocument['nodes'][string]
export type MaestroDocumentEdge = MaestroDocument['edges'][number]
export type MaestroEdgeType = z.infer<typeof maestroEdgeType>
export type MaestroEdgeDirection = z.infer<typeof maestroEdgeDirection>
export type MaestroNoteSnapshotPayload = z.infer<typeof authoringNotePayload>
export type MaestroAuthoringEdgePayload = z.infer<typeof authoringEdgePayload>

const canvasSurfaceKey = z.string().min(1).max(12_288)
const canvasActorId = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => value.split('').every((character) => character.charCodeAt(0) >= 32))
const canvasSize = z
  .object({
    width: z.number().finite().min(160).max(4096),
    height: z.number().finite().min(96).max(4096)
  })
  .strict()
const canvasPlacement = z
  .object({
    position: boundedLayoutPosition,
    size: canvasSize,
    collapsed: z.boolean(),
    z_order: z.number().int().min(0).max(1_000_000)
  })
  .strict()
const manualLinkFields = z
  .object({
    id: identifier,
    source_surface_key: canvasSurfaceKey,
    target_surface_key: canvasSurfaceKey,
    link_type: z.string().min(1).max(128),
    label: z.string().max(512).nullable(),
    author_id: canvasActorId,
    created_at: z.string().datetime(),
    revision: z.number().int().min(1)
  })
  .strict()
const manualLink = manualLinkFields.refine(
  (link) => link.source_surface_key !== link.target_surface_key,
  {
    message: 'Manual links need two exact endpoints.'
  }
)
const acceptedSuggestionLink = manualLinkFields
  .omit({ id: true, author_id: true, created_at: true })
  .refine((link) => link.source_surface_key !== link.target_surface_key, {
    message: 'Accepted suggestion links need two exact endpoints.'
  })
const suggestionDecision = z
  .object({
    fingerprint: canvasSurfaceKey,
    suggestion_revision: z.number().int().min(0),
    state: z.enum(['accepted', 'hidden']),
    decided_by: canvasActorId,
    decided_at: z.string().datetime(),
    accepted_link: acceptedSuggestionLink.nullable()
  })
  .strict()
  .refine(
    (decision) => (decision.state === 'accepted') === (decision.accepted_link !== null),
    'Only accepted suggestions persist their typed user link.'
  )

const workspaceAnnotation = z
  .object({
    surface_key: canvasSurfaceKey,
    relative_path: z.string().min(1).max(4096),
    tone: z.enum(['decision', 'warning', 'blocked', 'observation']),
    created_by: canvasActorId,
    created_at: z.string().datetime()
  })
  .strict()

export const WorkspaceCanvasDocumentSchema = z
  .object({
    schema_version: z.literal(1),
    last_surface_revision: z.number().int().min(0),
    viewport: boundedViewport.optional(),
    placements: z.record(z.string(), canvasPlacement),
    manual_links: z.array(manualLink).max(3000),
    suggestion_decisions: z.record(z.string(), suggestionDecision),
    annotations: z.record(z.string(), workspaceAnnotation).default({}),
    ui_preferences: z
      .object({
        inspector_open: z.boolean(),
        inspector_width: z.number().int().min(240).max(720)
      })
      .strict()
  })
  .strict()
  .refine(
    (document) =>
      Object.entries(document.suggestion_decisions).every(
        ([fingerprint, decision]) => fingerprint === decision.fingerprint
      ),
    'Suggestion decisions must be keyed by their stable fingerprint.'
  )
  .refine(
    (document) =>
      Object.entries(document.annotations).every(
        ([surfaceKey, annotation]) => surfaceKey === annotation.surface_key
      ),
    'Annotations must be keyed by their exact surface identity.'
  )

export type WorkspaceCanvasDocument = z.infer<typeof WorkspaceCanvasDocumentSchema>
export type WorkspaceCanvasManualLink = WorkspaceCanvasDocument['manual_links'][number]
export type WorkspaceCanvasSuggestionDecision =
  WorkspaceCanvasDocument['suggestion_decisions'][string]
