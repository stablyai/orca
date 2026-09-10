import { z } from 'zod'
import { parseWorkspaceKey } from './workspace-scope'

export const WORKSPACE_SURFACE_SNAPSHOT_PROTOCOL = 'workspace-surface-snapshot/v1' as const

const MAX_SURFACES = 512
const MAX_RELATIONSHIPS = 2048
const identifier = z.string().min(1).max(4096)
const workspaceKey = identifier.refine((value) => parseWorkspaceKey(value) !== null, {
  message: 'Workspace key must be an Orca public workspace key.'
})
const revision = z.number().int().min(0)
const timestamp = z.string().datetime()

export const WorkspaceSurfaceIdSchema = z
  .object({
    execution_host_id: identifier,
    workspace_key: workspaceKey,
    unified_tab_id: identifier
  })
  .strict()

export type WorkspaceSurfaceId = z.infer<typeof WorkspaceSurfaceIdSchema>

export function workspaceSurfaceKey(surfaceId: WorkspaceSurfaceId): string {
  return JSON.stringify([
    surfaceId.execution_host_id,
    surfaceId.workspace_key,
    surfaceId.unified_tab_id
  ])
}

const terminalBinding = z
  .object({
    kind: z.literal('terminal'),
    terminal_tab_id: identifier,
    pane_key: identifier,
    session_id: identifier.nullable(),
    pty_incarnation: identifier.nullable(),
    liveness: z.enum(['live', 'unverifiable', 'exited']),
    authority_revision: revision
  })
  .strict()

const browserFrameReceipt = z
  .object({
    frame_revision: revision,
    observed_at: timestamp
  })
  .strict()

const browserCaptureReceipt = z
  .object({
    artifact_ref: identifier,
    artifact_digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    page_revision: revision,
    captured_at: timestamp
  })
  .strict()

const browserBinding = z
  .object({
    kind: z.literal('browser'),
    browser_workspace_id: identifier,
    browser_page_id: identifier,
    profile_id: identifier.nullable(),
    partition_id: identifier.nullable(),
    authority_revision: revision,
    live_frame: browserFrameReceipt.nullable(),
    immutable_capture: browserCaptureReceipt.nullable()
  })
  .strict()

const contentBinding = z
  .object({
    kind: z.literal('content'),
    entity_id: identifier,
    content_type: z.enum(['editor', 'diff', 'conflict-review', 'check-details', 'simulator']),
    model_revision: identifier,
    owner_principal: identifier,
    read_only: z.boolean(),
    source: z
      .object({
        relative_path: z.string().min(1).max(4096),
        language: z.string().min(1).max(128),
        mode: z.enum(['edit', 'markdown-preview', 'diff']),
        diff_source: z.enum(['staged', 'unstaged']).nullable(),
        is_dirty: z.boolean()
      })
      .strict()
      .nullable()
      .default(null),
    annotation: z
      .object({
        relative_path: z.string().min(1).max(4096),
        tone: z.enum(['decision', 'warning', 'blocked', 'observation'])
      })
      .strict()
      .nullable()
      .default(null)
  })
  .strict()

export const WorkspaceResourceBindingSchema = z.discriminatedUnion('kind', [
  terminalBinding,
  browserBinding,
  contentBinding
])

const surfaceRecord = z
  .object({
    id: WorkspaceSurfaceIdSchema,
    content_type: z.enum([
      'terminal',
      'browser',
      'editor',
      'diff',
      'conflict-review',
      'check-details',
      'simulator'
    ]),
    entity_id: identifier,
    group_id: identifier,
    title: z.string().min(1).max(512),
    revision,
    availability: z.enum(['available', 'unavailable', 'unverifiable']),
    binding: WorkspaceResourceBindingSchema
  })
  .strict()
  .superRefine((surface, context) => {
    const expectedKind =
      surface.content_type === 'terminal' || surface.content_type === 'browser'
        ? surface.content_type
        : 'content'
    if (surface.binding.kind !== expectedKind) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Surface content type and resource authority do not match.'
      })
    }
    if (
      surface.binding.kind === 'content' &&
      surface.binding.content_type !== surface.content_type
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Content binding must preserve the concrete tab content type.'
      })
    }
  })

const automaticLink = z
  .object({
    id: identifier,
    source_surface_key: identifier,
    target_surface_key: identifier,
    link_type: z.enum(['controls', 'executes', 'produces', 'parent-child', 'resource-binding']),
    authority_kind: z.enum([
      'opener-control-receipt',
      'execution-receipt',
      'evidence-production-receipt',
      'parent-child-receipt',
      'resource-binding-receipt'
    ]),
    authority_id: identifier,
    authority_revision: revision,
    observed_at: timestamp,
    explanation_code: z.enum([
      'opened-or-controls',
      'executes-resource',
      'produced-evidence',
      'parent-child',
      'explicit-resource-binding'
    ])
  })
  .strict()

const suggestedLink = z
  .object({
    fingerprint: identifier,
    revision,
    source_surface_key: identifier,
    target_surface_key: identifier,
    link_type: z.string().min(1).max(128),
    reason: z.string().min(1).max(1024),
    evidence_summary: z.string().min(1).max(2048)
  })
  .strict()

const harnessOverlay = z
  .object({
    protocol: z.string().min(1).max(128),
    run_id: identifier,
    revision,
    artifact_ref: identifier
  })
  .strict()

export const WorkspaceSurfaceSnapshotSchema = z
  .object({
    schema_version: z.literal(1),
    protocol: z.literal(WORKSPACE_SURFACE_SNAPSHOT_PROTOCOL),
    execution_host_id: identifier,
    workspace_key: workspaceKey,
    authority_revision: revision,
    authority_cursor: identifier,
    state: z.enum(['loading', 'ready', 'unavailable']),
    surfaces: z.record(z.string(), surfaceRecord).superRefine((surfaces, context) => {
      if (Object.keys(surfaces).length > MAX_SURFACES) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Snapshot has too many surfaces.'
        })
      }
      for (const [key, surface] of Object.entries(surfaces)) {
        if (key !== workspaceSurfaceKey(surface.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Surface ${key} is not keyed by its exact identity.`
          })
        }
      }
    }),
    unsupported: z
      .array(
        z
          .object({ content_type: z.string().min(1).max(128), count: z.number().int().min(1) })
          .strict()
      )
      .max(32),
    automatic_links: z.array(automaticLink).max(MAX_RELATIONSHIPS),
    suggested_links: z.array(suggestedLink).max(MAX_RELATIONSHIPS),
    capability: z
      .object({ available: z.boolean(), reason: z.string().min(1).max(512).nullable() })
      .strict(),
    harness_overlay: harnessOverlay.nullable()
  })
  .strict()
  .superRefine((snapshot, context) => {
    for (const surface of Object.values(snapshot.surfaces)) {
      if (
        surface.id.execution_host_id !== snapshot.execution_host_id ||
        surface.id.workspace_key !== snapshot.workspace_key
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Every surface must belong to the exact snapshot scope.'
        })
      }
    }
    const surfaceKeys = new Set(Object.keys(snapshot.surfaces))
    for (const link of [...snapshot.automatic_links, ...snapshot.suggested_links]) {
      if (!surfaceKeys.has(link.source_surface_key) || !surfaceKeys.has(link.target_surface_key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Snapshot relationships need two exact surface endpoints.'
        })
      }
    }
  })

export type WorkspaceResourceBinding = z.infer<typeof WorkspaceResourceBindingSchema>
export type WorkspaceSurface = z.infer<typeof surfaceRecord>
export type WorkspaceAutomaticLink = z.infer<typeof automaticLink>
export type WorkspaceSuggestedLink = z.infer<typeof suggestedLink>
export type WorkspaceSurfaceSnapshot = z.infer<typeof WorkspaceSurfaceSnapshotSchema>
