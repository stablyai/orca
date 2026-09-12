import { z } from 'zod'

export const CANVAS_CONTEXT_RESPONSE_HEADER = 'x-orca-canvas-context'
export const canvasContextBindingSchema = z
  .object({
    nodeId: z.string().min(1).max(128),
    paneKey: z.string().min(1).max(1024),
    worktreeId: z.string().min(1).max(8192),
    ptyId: z.string().min(1).max(1024),
    provider: z.enum(['codex', 'claude', 'cursor']),
    name: z.string().max(1024).optional(),
    peers: z.array(z.string().min(1).max(128)).max(100).optional(),
    collaborationPaused: z.boolean().optional(),
    notes: z
      .array(
        z.object({
          id: z.string().max(128),
          title: z.string().max(1024),
          content: z.string().max(32_000)
        })
      )
      .max(32)
  })
  .refine(
    (value) =>
      value.notes.reduce((sum, note) => sum + note.content.length + note.title.length, 0) <=
      (value.provider === 'cursor' ? 9_000 : 32_000),
    'Linked notes exceed the context limit (32,000 characters; 9,000 for Cursor).'
  )
export const canvasContextReplaceSchema = z.object({
  canvasId: z.string().min(1).max(16_384),
  revision: z.number().int().nonnegative().safe(),
  bindings: z.array(canvasContextBindingSchema).max(100)
})
export type CanvasContextBinding = z.infer<typeof canvasContextBindingSchema>
export type CanvasContextReplace = z.infer<typeof canvasContextReplaceSchema>
export const canvasContextDeferredBindingSchema = z.object({
  nodeId: canvasContextBindingSchema.shape.nodeId,
  name: canvasContextBindingSchema.shape.name,
  peers: canvasContextBindingSchema.shape.peers,
  collaborationPaused: canvasContextBindingSchema.shape.collaborationPaused,
  notes: canvasContextBindingSchema.shape.notes
})
export type CanvasContextDeferredBinding = z.infer<typeof canvasContextDeferredBindingSchema>
export const canvasContextSyncSchema = canvasContextReplaceSchema
  .extend({
    deferredBindings: z.array(canvasContextDeferredBindingSchema).max(100)
  })
  .refine((value) => {
    const ids = [...value.bindings, ...value.deferredBindings].map((binding) => binding.nodeId)
    return ids.length <= 100 && new Set(ids).size === ids.length
  }, 'Canvas bindings must have unique node IDs and at most 100 agents.')
export type CanvasContextSync = z.infer<typeof canvasContextSyncSchema>
export const canvasContextReceiptSchema = z.object({
  revision: z.number().int().nonnegative().safe(),
  nodes: z.record(
    z.string(),
    z.object({
      state: z.enum([
        'waiting',
        'ready',
        'returned',
        'session-changed',
        'unsupported',
        'unverifiable'
      ]),
      provider: z.enum(['codex', 'claude', 'cursor'])
    })
  )
})
export type CanvasContextReceipt = z.infer<typeof canvasContextReceiptSchema>
export type CanvasContextState = CanvasContextReceipt['nodes'][string]['state']
export type CanvasContextIdentity = { sessionId: string; launchTokenHash: string }
