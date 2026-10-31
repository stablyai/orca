import { z } from 'zod'

export const persistedOpenFileSchema = z.object({
  // Why: additive; a corrupt id falls back to undefined rather than dropping the file.
  id: z.string().min(1).optional().catch(undefined),
  filePath: z.string(),
  relativePath: z.string(),
  worktreeId: z.string(),
  language: z.string(),
  isPreview: z.boolean().optional(),
  runtimeEnvironmentId: z.string().nullable().optional(),
  mirroredFromRuntimeSession: z.literal(true).optional(),
  externalSshTargetId: z.string().trim().min(1).optional(),
  dirtyDraftContent: z.string().optional(),
  lastKnownDiskSignature: z.string().optional(),
  readOnly: z.boolean().optional(),
  liveTail: z.boolean().optional()
})
