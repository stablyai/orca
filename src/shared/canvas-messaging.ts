import { z } from 'zod'

export const canvasMessageKindSchema = z.enum(['question', 'info', 'request', 'reply'])
export const canvasMessageStateSchema = z.enum([
  'queued',
  'sending',
  'delivered',
  'received',
  'cancelled',
  'unverifiable'
])
export const canvasMessageSchema = z.object({
  id: z.string(),
  canvasId: z.string(),
  source: z.string(),
  target: z.string(),
  sourceEpoch: z.string(),
  targetEpoch: z.string(),
  sourceName: z.string(),
  targetName: z.string(),
  kind: canvasMessageKindSchema,
  body: z.string(),
  replyTo: z.string().nullable(),
  threadId: z.string(),
  state: canvasMessageStateSchema,
  detail: z.string(),
  createdAt: z.number()
})
export type CanvasMessage = z.infer<typeof canvasMessageSchema>
export const canvasActorSchema = z.object({
  paneKey: z.string().min(1).max(1024),
  launchToken: z.string().min(1).max(4096)
})
export const canvasSendSchema = canvasActorSchema.extend({
  canvasId: z.string().min(1).max(16384),
  to: z.string().min(1).max(128),
  kind: canvasMessageKindSchema.default('info'),
  body: z.string().trim().min(1).max(8000),
  replyTo: z.string().max(128).optional(),
  requestId: z.string().uuid()
})
