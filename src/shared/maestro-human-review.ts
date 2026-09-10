import { z } from 'zod'
import { MaestroActorSchema, MaestroWorkspaceAnchorSchema } from './maestro-contract'
import { MaestroBrowserProfileConsentReceiptSchema } from './maestro-browser-surface'

export const MAESTRO_HUMAN_REVIEW_PROTOCOL = 'maestro-human-review/v1' as const

const identifier = z.string().regex(/^[A-Za-z0-9]+(?:[._-][A-Za-z0-9]+)*$/)
const boundedText = z.string().trim().min(1).max(4096)
const timestamp = z.string().datetime()

const HumanActorSchema = MaestroActorSchema.extend({
  kind: z.literal('user'),
  authenticated: z.literal(true)
}).strict()

export const MaestroHumanReviewStateSchema = z.enum([
  'staged',
  'needs_input',
  'approved_for_submit',
  'submitted',
  'rejected',
  'expired'
])

export const MaestroHumanReviewReferencesSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            document_ref: boundedText,
            field_path: boundedText,
            label: z.string().trim().min(1).max(512)
          })
          .strict()
      )
      .max(128),
    documents: z
      .array(
        z
          .object({
            document_ref: boundedText,
            revision: boundedText,
            title: z.string().trim().min(1).max(512)
          })
          .strict()
      )
      .max(64),
    browser: z
      .object({
        surface_id: identifier,
        browser_page_id: identifier,
        profile_consent_receipt: MaestroBrowserProfileConsentReceiptSchema.optional()
      })
      .strict()
      .nullable()
  })
  .strict()
  .superRefine((references, context) => {
    if (references.fields.length + references.documents.length === 0 && !references.browser) {
      context.addIssue({
        code: 'custom',
        path: ['fields'],
        message: 'A human review requires at least one immutable reference.'
      })
    }
  })

export const MaestroHumanReviewDecisionSchema = z
  .object({ decision_id: identifier, prompt: boundedText })
  .strict()

const ReviewReceiptBaseSchema = z
  .object({
    receipt_id: identifier,
    request_id: identifier.optional(),
    actor: HumanActorSchema,
    recorded_at: timestamp
  })
  .strict()

export const MaestroHumanReviewSchema = z
  .object({
    schema_version: z.literal(1),
    protocol: z.literal(MAESTRO_HUMAN_REVIEW_PROTOCOL),
    review_id: identifier,
    workspace: MaestroWorkspaceAnchorSchema,
    coordinator_generation: z.number().int().min(1),
    task_id: identifier,
    dispatch_id: identifier,
    title: z.string().trim().min(1).max(512),
    summary: boundedText,
    state: MaestroHumanReviewStateSchema,
    references: MaestroHumanReviewReferencesSchema,
    decisions: z.array(MaestroHumanReviewDecisionSchema).max(64),
    unresolved_decisions: z.array(MaestroHumanReviewDecisionSchema).max(64),
    staged_receipt: z
      .object({
        receipt_id: identifier,
        actor: MaestroActorSchema.extend({ authenticated: z.literal(true) }),
        state: z.enum(['staged', 'needs_input']),
        recorded_at: timestamp
      })
      .strict(),
    approval_receipt: ReviewReceiptBaseSchema.extend({
      decision_resolutions: z
        .array(z.object({ decision_id: identifier, resolution: boundedText }).strict())
        .max(64),
      expires_at: timestamp
    })
      .strict()
      .nullable(),
    submission_receipt: ReviewReceiptBaseSchema.extend({ submission_reference: boundedText })
      .strict()
      .nullable(),
    rejection_receipt: ReviewReceiptBaseSchema.extend({ reason: boundedText }).strict().nullable(),
    expiration_receipt: z
      .object({ receipt_id: identifier, expired_at: timestamp, recorded_at: timestamp })
      .strict()
      .nullable(),
    created_at: timestamp,
    updated_at: timestamp
  })
  .strict()

export const MaestroHumanReviewCreateRequestSchema = z
  .object({
    request_id: identifier,
    workspace: MaestroWorkspaceAnchorSchema,
    coordinator_generation: z.number().int().min(1),
    review_id: identifier,
    task_id: identifier,
    dispatch_id: identifier,
    title: z.string().trim().min(1).max(512),
    summary: boundedText,
    state: z.enum(['staged', 'needs_input']),
    references: MaestroHumanReviewReferencesSchema,
    decisions: z.array(MaestroHumanReviewDecisionSchema).max(64)
  })
  .strict()

export const MaestroHumanReviewListRequestSchema = z
  .object({ workspace: MaestroWorkspaceAnchorSchema })
  .strict()

export const MaestroHumanReviewTransitionRequestSchema = z.discriminatedUnion('action', [
  z
    .object({
      request_id: identifier,
      workspace: MaestroWorkspaceAnchorSchema,
      review_id: identifier,
      action: z.literal('approve'),
      receipt_id: identifier,
      decision_resolutions: z.array(
        z.object({ decision_id: identifier, resolution: boundedText }).strict()
      ),
      expires_at: timestamp
    })
    .strict(),
  z
    .object({
      request_id: identifier,
      workspace: MaestroWorkspaceAnchorSchema,
      review_id: identifier,
      action: z.literal('submit'),
      receipt_id: identifier,
      submission_reference: boundedText
    })
    .strict(),
  z
    .object({
      request_id: identifier,
      workspace: MaestroWorkspaceAnchorSchema,
      review_id: identifier,
      action: z.literal('reject'),
      receipt_id: identifier,
      reason: boundedText
    })
    .strict()
])

export type MaestroHumanReview = z.infer<typeof MaestroHumanReviewSchema>
export type MaestroHumanReviewCreateRequest = z.infer<typeof MaestroHumanReviewCreateRequestSchema>
export type MaestroHumanReviewTransitionRequest = z.infer<
  typeof MaestroHumanReviewTransitionRequestSchema
>
