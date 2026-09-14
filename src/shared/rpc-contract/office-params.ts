import { z } from 'zod'
import { isValidOfficeDocumentPath, isValidOfficeRelativePath } from '../office-preview-rpc'

// Refined through the shared predicates rather than restating their rules: zod alone accepted a
// whitespace-only or NUL-carrying string that `isValidOfficeDocumentPath` rejects, and an invalid
// optional `workspaceRoot` then read as absent — silently probing this host's default lane instead
// of failing the call.
const WorkspaceRoot = z
  .string()
  .max(4096)
  .refine(isValidOfficeDocumentPath, { message: 'workspaceRoot is not a usable path' })
/**
 * Never absolute: the host joins this onto the workspace root and refuses anything that
 * canonicalises outside it, matching every neighbouring `files.*` method.
 */
const RelativePath = z.string().max(2048).refine(isValidOfficeRelativePath, {
  message: 'relativePath must be a non-empty path relative to the workspace root'
})
const WorkspaceDocument = { workspaceRoot: WorkspaceRoot, relativePath: RelativePath }
const SkillId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/i)

export const OfficeOptionalDocumentParams = z
  .object({ workspaceRoot: WorkspaceRoot.optional() })
  .strict()
export const OfficeProbeParams = z
  .object({ workspaceRoot: WorkspaceRoot.optional(), refresh: z.boolean().optional() })
  .strict()
export const OfficeDocumentParams = z.object(WorkspaceDocument).strict()
export const OfficeElementParams = z
  .object({ ...WorkspaceDocument, elementPath: z.string().min(1).max(1024).startsWith('/') })
  .strict()
export const OfficeSkillInstallParams = z
  .object({
    pairs: z
      .array(z.object({ skill: SkillId, agent: SkillId }).strict())
      .min(1)
      .max(200),
    workspaceRoot: WorkspaceRoot.optional()
  })
  .strict()
