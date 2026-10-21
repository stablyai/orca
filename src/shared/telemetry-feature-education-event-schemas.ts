import { z } from 'zod'
import {
  CONTEXTUAL_TOUR_OUTCOMES,
  FEATURE_EDUCATION_CONTEXTUAL_TOUR_IDS,
  FEATURE_EDUCATION_SOURCES,
  SETUP_GUIDE_CLOSE_OUTCOMES,
  SETUP_GUIDE_SOURCES,
  TERMINAL_PANE_SPLIT_SOURCES
} from './feature-education-telemetry'
import { FEATURE_WALL_SETUP_STEP_IDS } from './feature-wall-setup-steps'

export const featureEducationSourceSchema = z.enum(FEATURE_EDUCATION_SOURCES)
export const featureEducationContextualTourIdSchema = z.enum(FEATURE_EDUCATION_CONTEXTUAL_TOUR_IDS)
export const setupGuideSourceSchema = z.enum(SETUP_GUIDE_SOURCES)
export const setupGuideCloseOutcomeSchema = z.enum(SETUP_GUIDE_CLOSE_OUTCOMES)
export const setupGuideStepIdSchema = z.enum(FEATURE_WALL_SETUP_STEP_IDS)
export const setupGuideStepIdOrNoneSchema = z.enum([
  ...FEATURE_WALL_SETUP_STEP_IDS,
  'none'
] as const)
export const terminalPaneSplitSourceSchema = z.enum(TERMINAL_PANE_SPLIT_SOURCES)

export const contextualTourShownSchema = z
  .object({
    tour_id: featureEducationContextualTourIdSchema,
    source: featureEducationSourceSchema,
    was_feature_previously_interacted: z.boolean()
  })
  .strict()

export const contextualTourOutcomeSchema = z
  .object({
    tour_id: featureEducationContextualTourIdSchema,
    source: featureEducationSourceSchema,
    outcome: z.enum(CONTEXTUAL_TOUR_OUTCOMES),
    steps_seen: z.number().int().min(0).max(8),
    total_steps: z.number().int().min(1).max(8),
    furthest_step_index: z.number().int().min(1).max(8).optional(),
    defined_step_count: z.number().int().min(1).max(8).optional()
  })
  .refine((payload) => payload.steps_seen <= payload.total_steps, {
    message: 'steps_seen must be less than or equal to total_steps',
    path: ['steps_seen']
  })
  .refine(
    (payload) =>
      payload.furthest_step_index === undefined ||
      payload.defined_step_count === undefined ||
      payload.furthest_step_index <= payload.defined_step_count,
    {
      message: 'furthest_step_index must be less than or equal to defined_step_count',
      path: ['furthest_step_index']
    }
  )
  .refine(
    (payload) =>
      (payload.furthest_step_index === undefined) === (payload.defined_step_count === undefined),
    {
      message: 'furthest_step_index and defined_step_count must be sent together',
      path: ['defined_step_count']
    }
  )
  .strict()

export const setupGuideOpenedSchema = z
  .object({
    source: setupGuideSourceSchema,
    initial_completed_count: z.number().int().min(0).max(8),
    total_steps: z.literal(8),
    first_incomplete_step_id: setupGuideStepIdOrNoneSchema
  })
  .strict()

export const setupGuideClosedSchema = z
  .object({
    source: setupGuideSourceSchema,
    outcome: setupGuideCloseOutcomeSchema,
    initial_completed_count: z.number().int().min(0).max(8),
    final_completed_count: z.number().int().min(0).max(8),
    total_steps: z.literal(8),
    active_step_id: setupGuideStepIdOrNoneSchema
  })
  .refine((payload) => payload.final_completed_count >= payload.initial_completed_count, {
    message: 'final_completed_count must be greater than or equal to initial_completed_count',
    path: ['final_completed_count']
  })
  .strict()

export const setupGuideStepCompletedSchema = z
  .object({
    step_id: setupGuideStepIdSchema,
    section_id: z.enum(['parallel-work', 'setup']),
    completed_count: z.number().int().min(1).max(8),
    total_steps: z.literal(8),
    setup_guide_visible: z.boolean()
  })
  .strict()

export const terminalPaneSplitSchema = z
  .object({
    source: terminalPaneSplitSourceSchema,
    direction: z.enum(['vertical', 'horizontal'])
  })
  .strict()

// Why: measures the changed-on-disk conflict flow (issue #7265) per transport; deliberately path-free.
export const editorExternalChangeConflictShownSchema = z
  .object({
    surface: z.enum(['edit', 'unstaged-diff']),
    transport: z.enum(['local', 'ssh', 'runtime']),
    origin: z.enum(['live', 'restore'])
  })
  .strict()

export const editorExternalChangeConflictActionSchema = z
  .object({
    action: z.enum(['reload', 'keep', 'compare', 'undo_reload', 'save_overwrite']),
    surface: z.enum(['edit', 'unstaged-diff']),
    transport: z.enum(['local', 'ssh', 'runtime'])
  })
  .strict()
