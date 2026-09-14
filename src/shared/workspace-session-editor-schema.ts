/* Why: the editor slice of the persisted workspace session. Split out of
 * workspace-session-schema.ts to keep that file inside its line budget, the
 * same way the browser slice already is; the schema itself is unchanged. */
import { z } from 'zod'

export const persistedOpenFileSchema = z.object({
  filePath: z.string(),
  relativePath: z.string(),
  worktreeId: z.string(),
  language: z.string(),
  isPreview: z.boolean().optional(),
  runtimeEnvironmentId: z.string().nullable().optional(),
  externalSshTargetId: z.string().trim().min(1).optional(),
  dirtyDraftContent: z.string().optional(),
  lastKnownDiskSignature: z.string().optional(),
  readOnly: z.boolean().optional(),
  liveTail: z.boolean().optional()
})
