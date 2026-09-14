import { z } from 'zod'
import {
  NESTED_REPO_COUNT_BUCKETS,
  NESTED_REPO_IMPORT_ACTIONS,
  NESTED_REPO_IMPORT_OUTCOMES,
  NESTED_REPO_SCAN_RESULTS,
  NESTED_REPO_TELEMETRY_MAX_REPO_COUNT,
  NESTED_REPO_TELEMETRY_RUNTIME_KINDS,
  NESTED_REPO_TELEMETRY_SURFACES,
  bucketNestedRepoTelemetryCount
} from './nested-repo-telemetry'
import { nthRepoAddedSchema } from './telemetry-app-event-schemas'
import {
  addRepoDefaultCheckoutHandoffReasonSchema,
  addRepoDefaultCheckoutHandoffResultSchema,
  addRepoDefaultCheckoutHandoffSourceSchema,
  addRepoExistingWorkspaceSourceSchema,
  addRepoSetupStepActionSchema,
  setupScriptImportProviderSchema,
  workspaceCreateErrorClassSchema,
  workspaceSourceSchema
} from './telemetry-property-schemas'

export const existingWorkspaceCountSchema = z.number().int().min(1).max(50)
export const addRepoExistingWorkspaceContextSchema = {
  source: addRepoExistingWorkspaceSourceSchema,
  existing_workspace_count: existingWorkspaceCountSchema,
  existing_linked_workspace_count: z.number().int().min(0).max(50)
} as const

export const addRepoSetupStepActionEventSchema = z
  .object({
    action: addRepoSetupStepActionSchema,
    source: addRepoExistingWorkspaceSourceSchema.optional(),
    existing_workspace_count: existingWorkspaceCountSchema.optional(),
    existing_linked_workspace_count: z.number().int().min(0).max(50).optional(),
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
export const addRepoExistingWorkspacesDetectedSchema = z
  .object({
    ...addRepoExistingWorkspaceContextSchema,
    main_workspace_count: z.number().int().min(0).max(50),
    branch_named_workspace_count: z.number().int().min(0).max(50),
    detached_workspace_count: z.number().int().min(0).max(50),
    custom_named_workspace_count: z.number().int().min(0).max(50),
    sparse_workspace_count: z.number().int().min(0).max(50),
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()
export const addRepoDefaultCheckoutHandoffSchema = z
  .object({
    source: addRepoDefaultCheckoutHandoffSourceSchema,
    result: addRepoDefaultCheckoutHandoffResultSchema,
    reason: addRepoDefaultCheckoutHandoffReasonSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

// Why: enum-only like `agent_error` — `.strict()` blocks raw error strings from ever crossing the wire.
export const workspaceCreateFailedSchema = z
  .object({
    source: workspaceSourceSchema,
    error_class: workspaceCreateErrorClassSchema,
    nth_repo_added: nthRepoAddedSchema
  })
  .strict()

export const setupScriptPromptModeSchema = z.enum(['import_available', 'configure_needed'])
export const setupScriptCountBucketSchema = z.enum(['0', '1', '2-3', '4+'])
export const setupScriptPromptContextSchema = {
  mode: setupScriptPromptModeSchema,
  // Why: superRefine (not transform) keeps the top-level ZodObject shape that cohort injection probes.
  provider: setupScriptImportProviderSchema.optional(),
  file_count_bucket: setupScriptCountBucketSchema,
  unsupported_field_count_bucket: setupScriptCountBucketSchema,
  has_shared_hooks: z.boolean(),
  nth_repo_added: nthRepoAddedSchema
} as const

export type SetupScriptPromptContextTelemetry = {
  mode: z.infer<typeof setupScriptPromptModeSchema>
  provider?: z.infer<typeof setupScriptImportProviderSchema>
}

export function validateSetupScriptPromptProvider(
  props: SetupScriptPromptContextTelemetry,
  ctx: z.RefinementCtx
): void {
  if (props.mode === 'import_available' && props.provider === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['provider'],
      message: 'provider is required when a setup candidate is available'
    })
  }
  if (props.mode === 'configure_needed' && props.provider !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['provider'],
      message: 'provider is only valid when a setup candidate is available'
    })
  }
}
// Why: retention-cohort telemetry, not repo debugging — closed enums and count buckets only.
export const setupScriptPromptShownSchema = z
  .object(setupScriptPromptContextSchema)
  .strict()
  .superRefine(validateSetupScriptPromptProvider)
export const setupScriptDetectedSaveActions = [
  'save_detected_setup_clicked',
  'save_detected_setup_completed',
  'save_detected_setup_failed'
] as const

export function isSetupScriptDetectedSaveAction(action: unknown): boolean {
  return setupScriptDetectedSaveActions.includes(action as never)
}

export function validateSetupScriptPromptAction(
  props: SetupScriptPromptContextTelemetry & {
    action?: string
    edited_before_save?: boolean
  },
  ctx: z.RefinementCtx
): void {
  validateSetupScriptPromptProvider(props, ctx)
  const isDetectedSave = isSetupScriptDetectedSaveAction(props.action)
  if (isDetectedSave && props.provider !== 'package-manager') {
    ctx.addIssue({
      code: 'custom',
      path: ['provider'],
      message: 'detected setup save actions require the package-manager provider'
    })
  }
  if (isDetectedSave && props.edited_before_save === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['edited_before_save'],
      message: 'edited_before_save is required for detected setup save actions'
    })
  }
  if (!isDetectedSave && props.edited_before_save !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['edited_before_save'],
      message: 'edited_before_save is only valid for detected setup save actions'
    })
  }
}

export const setupScriptPromptActionSchema = z
  .object({
    ...setupScriptPromptContextSchema,
    action: z.enum([
      'import_completed',
      'import_failed',
      'configure_clicked',
      'dismissed',
      ...setupScriptDetectedSaveActions
    ]),
    edited_before_save: z.boolean().optional()
  })
  .strict()
  .superRefine(validateSetupScriptPromptAction)

export const nestedRepoTelemetrySurfaceSchema = z.enum(NESTED_REPO_TELEMETRY_SURFACES)
export const nestedRepoTelemetryRuntimeKindSchema = z.enum(NESTED_REPO_TELEMETRY_RUNTIME_KINDS)
export const nestedRepoCountSchema = z
  .number()
  .int()
  .min(0)
  .max(NESTED_REPO_TELEMETRY_MAX_REPO_COUNT)
export const nestedRepoCountBucketSchema = z.enum(NESTED_REPO_COUNT_BUCKETS)
export const nestedRepoScanResultSchema = z.enum(NESTED_REPO_SCAN_RESULTS)
export const nestedRepoImportActionSchema = z.enum(NESTED_REPO_IMPORT_ACTIONS)
export const nestedRepoImportOutcomeSchema = z.enum(NESTED_REPO_IMPORT_OUTCOMES)
export const nestedRepoScanPathKindSchema = z.enum(['git_repo', 'non_git_folder'])
export const nestedRepoImportModeSchema = z.enum(['group', 'separate'])
export const nestedRepoAttemptIdSchema = z.string().uuid()

export function validateNestedRepoCountBucket(
  props: Record<string, unknown>,
  countKey: string,
  bucketKey: string,
  ctx: z.RefinementCtx
): void {
  const count = props[countKey]
  const bucket = props[bucketKey]
  if (typeof count !== 'number' || typeof bucket !== 'string') {
    return
  }
  if (bucketNestedRepoTelemetryCount(count) !== bucket) {
    ctx.addIssue({
      code: 'custom',
      path: [bucketKey],
      message: `${bucketKey} must match ${countKey}`
    })
  }
}

export function validateNestedRepoCountBuckets(
  props: Record<string, unknown>,
  ctx: z.RefinementCtx
): void {
  validateNestedRepoCountBucket(props, 'found_count', 'found_count_bucket', ctx)
  validateNestedRepoCountBucket(props, 'selected_count', 'selected_count_bucket', ctx)
  validateNestedRepoCountBucket(props, 'imported_count', 'imported_count_bucket', ctx)
  validateNestedRepoCountBucket(props, 'already_known_count', 'already_known_count_bucket', ctx)
  validateNestedRepoCountBucket(props, 'failed_count', 'failed_count_bucket', ctx)
}

export const nestedRepoTelemetryBaseSchema = {
  // Why: high-cardinality but random and non-persistent — correlates scan→action→result without path-derived IDs.
  attempt_id: nestedRepoAttemptIdSchema,
  surface: nestedRepoTelemetrySurfaceSchema,
  runtime_kind: nestedRepoTelemetryRuntimeKindSchema,
  nth_repo_added: nthRepoAddedSchema
} as const

export const addRepoNestedScanResultSchema = z
  .object({
    ...nestedRepoTelemetryBaseSchema,
    result: nestedRepoScanResultSchema,
    selected_path_kind: nestedRepoScanPathKindSchema.optional(),
    found_count: nestedRepoCountSchema,
    found_count_bucket: nestedRepoCountBucketSchema,
    truncated: z.boolean(),
    timed_out: z.boolean()
  })
  .strict()
  .superRefine(validateNestedRepoCountBuckets)

export const addRepoNestedImportActionSchema = z
  .object({
    ...nestedRepoTelemetryBaseSchema,
    action: nestedRepoImportActionSchema,
    found_count: nestedRepoCountSchema,
    found_count_bucket: nestedRepoCountBucketSchema,
    selected_count: nestedRepoCountSchema,
    selected_count_bucket: nestedRepoCountBucketSchema,
    all_selected: z.boolean()
  })
  .strict()
  .superRefine(validateNestedRepoCountBuckets)

export const addRepoNestedImportResultSchema = z
  .object({
    ...nestedRepoTelemetryBaseSchema,
    mode: nestedRepoImportModeSchema,
    outcome: nestedRepoImportOutcomeSchema,
    found_count: nestedRepoCountSchema,
    found_count_bucket: nestedRepoCountBucketSchema,
    selected_count: nestedRepoCountSchema,
    selected_count_bucket: nestedRepoCountBucketSchema,
    imported_count: nestedRepoCountSchema,
    imported_count_bucket: nestedRepoCountBucketSchema,
    already_known_count: nestedRepoCountSchema,
    already_known_count_bucket: nestedRepoCountBucketSchema,
    failed_count: nestedRepoCountSchema,
    failed_count_bucket: nestedRepoCountBucketSchema,
    all_selected: z.boolean()
  })
  .strict()
  .superRefine(validateNestedRepoCountBuckets)
