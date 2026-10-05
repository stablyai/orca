import { z } from 'zod'
import { normalizeExecutionHostId } from './execution-host'
import { editorRecoveryTextPatchSchema } from './editor-recovery-text-patch'

export const EDITOR_RECOVERY_BATCH_RECORD_LIMIT = 64
// Large cross-thread text messages leave substantial resident allocator memory behind.
export const EDITOR_RECOVERY_BATCH_TEXT_BYTES = 4 * 1024 * 1024

export const editorRecoveryMetadataSchema = z.object({
  hostId: z.string().refine((value) => normalizeExecutionHostId(value) !== null),
  worktreeId: z.string(),
  filePath: z.string(),
  relativePath: z.string(),
  language: z.string(),
  bufferKind: z.enum(['edit', 'diff']),
  runtimeEnvironmentId: z.string().nullable().optional(),
  externalSshTargetId: z.string().optional(),
  lastKnownDiskSignature: z.string().optional()
})

export type EditorRecoveryMetadata = z.infer<typeof editorRecoveryMetadataSchema>

export function editorRecoveryResourceKey(metadata: EditorRecoveryMetadata): string {
  // A path alone cannot distinguish drafts on different hosts or editable diff surfaces.
  return JSON.stringify([
    metadata.hostId,
    metadata.worktreeId,
    metadata.runtimeEnvironmentId ?? null,
    metadata.externalSshTargetId ?? null,
    metadata.filePath,
    metadata.bufferKind
  ])
}

export const editorRecoveryEntrySchema = editorRecoveryMetadataSchema.extend({
  id: z.string(),
  revision: z.number().int().positive(),
  updatedAt: z.number(),
  state: z.enum(['active', 'retained']),
  byteLength: z.number().int().nonnegative()
})
export type EditorRecoveryEntry = z.infer<typeof editorRecoveryEntrySchema>
export const editorRecoveryDraftSchema = editorRecoveryEntrySchema.extend({ content: z.string() })
export type EditorRecoveryDraft = z.infer<typeof editorRecoveryDraftSchema>

export const editorRecoveryChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('put'),
    id: z.string(),
    expectedRevision: z.number().int().nonnegative(),
    metadata: editorRecoveryMetadataSchema,
    content: z.string(),
    state: z.enum(['active', 'retained'])
  }),
  editorRecoveryTextPatchSchema.safeExtend({
    kind: z.literal('patch'),
    id: z.string(),
    expectedRevision: z.number().int().positive(),
    metadata: editorRecoveryMetadataSchema,
    state: z.enum(['active', 'retained'])
  }),
  z.object({
    kind: z.literal('retain'),
    id: z.string(),
    expectedRevision: z.number().int().positive()
  }),
  z.object({
    kind: z.literal('resolve'),
    id: z.string(),
    expectedRevision: z.number().int().nonnegative()
  })
])
export type EditorRecoveryChange = z.infer<typeof editorRecoveryChangeSchema>
export const editorRecoveryAckSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive().nullable()
})
export type EditorRecoveryAck = z.infer<typeof editorRecoveryAckSchema>
export const editorRecoveryStatusSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  state: z.enum(['active', 'retained', 'resolved'])
})
export type EditorRecoveryStatus = z.infer<typeof editorRecoveryStatusSchema>

export type EditorRecoveryApi = {
  list: () => Promise<EditorRecoveryEntry[]>
  read: (id: string) => Promise<EditorRecoveryDraft | null>
  apply: (changes: EditorRecoveryChange[]) => Promise<EditorRecoveryAck[]>
  /** Always creates a separate copy; the source draft remains recoverable. */
  export: (args: { id: string; revision: number }) => Promise<string | null>
}
