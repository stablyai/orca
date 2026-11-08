import { z } from 'zod'

export const ORCHESTRATION_RUN_EVENT_PAGE_LIMIT = 100

export const RunEventKindSchema = z.enum([
  'run.created',
  'run.coordinator_changed',
  'task.created',
  'task.status_changed',
  'task.removed',
  'dispatch.created',
  'dispatch.status_changed',
  'dispatch.removed',
  'gate.created',
  'gate.status_changed',
  'gate.removed'
])

export const RunEventDataSchema = z.object({
  title: z.string().nullable().optional(),
  previousStatus: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  previousCoordinator: z.string().nullable().optional(),
  coordinator: z.string().nullable().optional(),
  generation: z.number().int().nonnegative().optional(),
  retryOfDispatchId: z.string().nullable().optional(),
  assignee: z.string().nullable().optional()
})

export const RunEventSchema = z.object({
  sequence: z.number().int().positive().safe(),
  runId: z.string(),
  kind: RunEventKindSchema,
  entityId: z.string(),
  taskId: z.string().nullable(),
  dispatchId: z.string().nullable(),
  recordedAt: z.iso.datetime(),
  data: RunEventDataSchema
})

export const RunEventsPageSchema = z.object({
  runId: z.string(),
  coverage: z.object({
    completeFromCreation: z.boolean(),
    recordedSince: z.iso.datetime()
  }),
  events: z.array(RunEventSchema).max(ORCHESTRATION_RUN_EVENT_PAGE_LIMIT),
  nextCursor: z.string().nullable()
})

export type RunEvent = z.infer<typeof RunEventSchema>
export type RunEventsPage = z.infer<typeof RunEventsPageSchema>
