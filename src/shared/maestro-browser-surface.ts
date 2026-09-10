import { z } from 'zod'
import { MaestroActorSchema, MaestroWorkspaceAnchorSchema } from './maestro-contract'

export const MAESTRO_BROWSER_SURFACE_PROTOCOL = 'maestro-browser-surface/v1' as const
export const MAESTRO_BROWSER_EVIDENCE_PROTOCOL = 'maestro-browser-evidence/v1' as const
export const MAESTRO_BROWSER_PROFILE_CONSENT_PROTOCOL =
  'maestro-browser-profile-consent/v1' as const

const identifier = z.string().regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/)
const boundedText = z.string().min(1).max(4096)
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const viewport = z
  .object({
    width: z.number().int().min(1).max(16_384),
    height: z.number().int().min(1).max(16_384),
    device_scale_factor: z.number().finite().min(0.25).max(8)
  })
  .strict()

export const MaestroBrowserVisibilitySchema = z.enum(['visible', 'offscreen'])
export const MaestroBrowserObservedVisibilitySchema = z.enum([
  'visible',
  'offscreen',
  'hidden',
  'unavailable',
  'unverifiable'
])
export const MaestroBrowserSurfaceStateSchema = z.enum([
  'reserved',
  'creating',
  'active',
  'retained',
  'release_pending',
  'released',
  'outcome_unknown',
  'unavailable'
])

export const MaestroBrowserProfileConsentReceiptSchema = z
  .object({
    schema_version: z.literal(1),
    protocol: z.literal(MAESTRO_BROWSER_PROFILE_CONSENT_PROTOCOL),
    consent_id: identifier,
    profile_id: identifier,
    run_id: identifier,
    task_id: identifier,
    attempt_id: identifier,
    granted_by: MaestroActorSchema.extend({ kind: z.literal('user') }),
    granted_at: z.string().datetime(),
    expires_at: z.string().datetime(),
    revoked_at: z.string().datetime().nullable()
  })
  .strict()

export const MaestroBrowserProfileConsentGrantRequestSchema = z
  .object({
    schema_version: z.literal(1),
    protocol: z.literal(MAESTRO_BROWSER_PROFILE_CONSENT_PROTOCOL),
    workspace: MaestroWorkspaceAnchorSchema,
    profile_id: identifier,
    task_id: identifier,
    attempt_id: identifier,
    expires_at: z.string().datetime()
  })
  .strict()

export const MaestroBrowserProfileConsentRevokeRequestSchema = z
  .object({
    schema_version: z.literal(1),
    protocol: z.literal(MAESTRO_BROWSER_PROFILE_CONSENT_PROTOCOL),
    workspace: MaestroWorkspaceAnchorSchema,
    consent_id: identifier
  })
  .strict()

/** `unobserved` means no paint probe ran; it is never a claim that the pane was blank. */
export const MaestroBrowserPanePaintSchema = z.enum(['painted', 'unpainted', 'unobserved'])

export const MaestroBrowserEvidenceRequestSchema = z
  .object({
    route_or_component: z.string().min(1).max(512),
    state: z.string().min(1).max(512),
    theme: z.enum(['light', 'dark']),
    source_revision: z.string().min(1).max(256),
    capture_mode: z.enum(['native-viewport', 'native-full-page'])
  })
  .strict()

export const MaestroBrowserEvidenceReceiptSchema = z
  .object({
    protocol: z.literal(MAESTRO_BROWSER_EVIDENCE_PROTOCOL),
    artifact_ref: z.string().min(1).max(4096),
    artifact_hash: digest,
    format: z.enum(['png', 'jpeg']),
    dimensions: viewport,
    route_or_component: z.string().min(1).max(512),
    state: z.string().min(1).max(512),
    theme: z.enum(['light', 'dark']),
    source_revision: z.string().min(1).max(256),
    capture_mode: z.enum(['native-viewport', 'native-full-page']),
    captured_at: z.string().datetime(),
    vision_review: z
      .object({
        outcome: z.enum(['pending', 'pass', 'fail', 'unobserved']),
        reviewer: z.string().min(1).max(128).nullable(),
        observation: z.string().min(1).max(2048).nullable()
      })
      .strict()
  })
  .strict()

export const MaestroBrowserFocusReceiptSchema = z
  .object({
    requested: z.boolean(),
    workspace_activated: z.boolean(),
    exact_page_selected: z.boolean(),
    native_pane_paint: MaestroBrowserPanePaintSchema,
    /** When the paint verdict was reached. Null exactly when `native_pane_paint` is `unobserved`. */
    observed_at: z.string().datetime().nullable(),
    unavailable_reason: z.string().min(1).max(512).nullable()
  })
  .strict()

export const MaestroBrowserReleaseReceiptSchema = z
  .object({
    requested: z.boolean(),
    outcome: z.enum(['not_requested', 'released', 'retained', 'not_owned', 'unverifiable']),
    exact_page_closed: z.boolean(),
    profile_affected: z.literal(false),
    observed_at: z.string().datetime().nullable(),
    reason: z.string().min(1).max(512).nullable()
  })
  .strict()

export const MaestroBrowserSurfaceRequestSchema = z
  .object({
    schema_version: z.literal(1),
    protocol: z.literal(MAESTRO_BROWSER_SURFACE_PROTOCOL),
    request_id: identifier,
    workspace: MaestroWorkspaceAnchorSchema,
    actor: MaestroActorSchema,
    coordinator_generation: z.number().int().min(1),
    task_id: identifier,
    attempt_id: identifier,
    agent_id: identifier,
    url: z.string().url().max(8192),
    title: z.string().min(1).max(512),
    browser_page_id: identifier.optional(),
    profile_id: identifier.nullable(),
    profile_consent_receipt: MaestroBrowserProfileConsentReceiptSchema.nullable().optional(),
    requested_visibility: MaestroBrowserVisibilitySchema,
    viewport,
    retention: z.enum(['release_when_settled', 'retain']),
    ownership: z.enum(['harness', 'user']),
    evidence: MaestroBrowserEvidenceRequestSchema
  })
  .strict()

export const MaestroBrowserSurfaceReleaseRequestSchema = z
  .object({
    schema_version: z.literal(1),
    protocol: z.literal(MAESTRO_BROWSER_SURFACE_PROTOCOL),
    request_id: identifier,
    workspace: MaestroWorkspaceAnchorSchema,
    actor: MaestroActorSchema,
    coordinator_generation: z.number().int().min(1),
    surface_id: identifier,
    profile_consent_receipt: MaestroBrowserProfileConsentReceiptSchema.nullable().optional(),
    reason: boundedText
  })
  .strict()

export const MaestroBrowserSurfaceActionRequestSchema = z
  .object({
    schema_version: z.literal(1),
    protocol: z.literal(MAESTRO_BROWSER_SURFACE_PROTOCOL),
    workspace: MaestroWorkspaceAnchorSchema,
    actor: MaestroActorSchema,
    coordinator_generation: z.number().int().min(1),
    surface_id: identifier,
    profile_consent_receipt: MaestroBrowserProfileConsentReceiptSchema.nullable().optional()
  })
  .strict()

export const MaestroBrowserSurfaceReceiptSchema = z
  .object({
    schema_version: z.literal(1),
    protocol: z.literal(MAESTRO_BROWSER_SURFACE_PROTOCOL),
    surface_id: identifier,
    request_id: identifier,
    run_id: identifier,
    task_id: identifier,
    attempt_id: identifier,
    agent_id: identifier,
    owner_principal: identifier,
    ownership: z.enum(['harness', 'user']),
    execution_host_id: boundedText,
    workspace_key: boundedText,
    browser_page_id: identifier.nullable(),
    title: z.string().min(1).max(512),
    url: z.string().min(1).max(8192),
    origin: z.string().min(1).max(2048),
    profile_id: identifier.nullable(),
    requested_visibility: MaestroBrowserVisibilitySchema,
    observed_visibility: MaestroBrowserObservedVisibilitySchema,
    viewport,
    retention: z.enum(['release_when_settled', 'retain']),
    state: MaestroBrowserSurfaceStateSchema,
    focus_receipt: MaestroBrowserFocusReceiptSchema,
    /** What this surface is evidence *of* — outlives any single capture. */
    evidence: MaestroBrowserEvidenceRequestSchema,
    evidence_receipt: MaestroBrowserEvidenceReceiptSchema.nullable(),
    release_receipt: MaestroBrowserReleaseReceiptSchema,
    created_at: z.string().datetime(),
    updated_at: z.string().datetime()
  })
  .strict()

export type MaestroBrowserSurfaceRequest = z.infer<typeof MaestroBrowserSurfaceRequestSchema>
export type MaestroBrowserProfileConsentReceipt = z.infer<
  typeof MaestroBrowserProfileConsentReceiptSchema
>
export type MaestroBrowserProfileConsentGrantRequest = z.infer<
  typeof MaestroBrowserProfileConsentGrantRequestSchema
>
export type MaestroBrowserProfileConsentRevokeRequest = z.infer<
  typeof MaestroBrowserProfileConsentRevokeRequestSchema
>
export type MaestroBrowserSurfaceReleaseRequest = z.infer<
  typeof MaestroBrowserSurfaceReleaseRequestSchema
>
export type MaestroBrowserSurfaceActionRequest = z.infer<
  typeof MaestroBrowserSurfaceActionRequestSchema
>
export type MaestroBrowserSurfaceReceipt = z.infer<typeof MaestroBrowserSurfaceReceiptSchema>
export type MaestroBrowserEvidenceReceipt = z.infer<typeof MaestroBrowserEvidenceReceiptSchema>
export type MaestroBrowserFocusReceipt = z.infer<typeof MaestroBrowserFocusReceiptSchema>
export type MaestroBrowserPanePaint = z.infer<typeof MaestroBrowserPanePaintSchema>
export type MaestroBrowserReleaseReceipt = z.infer<typeof MaestroBrowserReleaseReceiptSchema>
