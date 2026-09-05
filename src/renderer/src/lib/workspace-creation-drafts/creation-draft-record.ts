import { z } from 'zod'

export const CREATION_DRAFT_LIMIT = 64
export const CREATION_DRAFT_TEXT_BYTES = 64 * 1024

const identity = z.string().min(1).max(512)
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const draftFields = {
  id: identity,
  title: z.string().max(4096),
  text: z
    .string()
    .refine(
      (text) => new TextEncoder().encode(text).byteLength <= CREATION_DRAFT_TEXT_BYTES,
      'Creation draft exceeds 64 KiB'
    ),
  updatedAt: z.number().finite().nonnegative(),
  agent: identity,
  executionHostId: identity,
  target: z
    .object({
      worktreeId: z.string().min(1).max(65536),
      terminalHandle: identity.optional(),
      incarnationId: identity.optional(),
      tabId: identity.optional()
    })
    .strict()
    .optional(),
  delivery: z
    .object({ attemptId: identity, revision, state: z.enum(['sending', 'uncertain', 'delivered']) })
    .strict()
    .optional()
}

export const creationDraftSchema = z.object({ ...draftFields, revision }).strict()
export const creationDraftInputSchema = z.object(draftFields).strict()
export type CreationDraft = z.infer<typeof creationDraftSchema>
export type CreationDraftInput = Omit<CreationDraft, 'revision'>

export class CreationDraftConflictError extends Error {
  constructor(readonly current: CreationDraft | null) {
    super('Creation draft changed in another editor')
    this.name = 'CreationDraftConflictError'
  }
}

export class CreationDraftCapacityError extends Error {
  constructor() {
    super('Creation draft storage is full (64 drafts)')
    this.name = 'CreationDraftCapacityError'
  }
}
