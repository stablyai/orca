import { z } from 'zod'

const ProjectKey = z.string().min(1).max(2048)
const OperationId = z
  .object({
    writer: z.string().min(1).max(128),
    seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
  .strict()

export const RecordProjectOpenParams = z
  .object({
    projectKey: ProjectKey,
    previousProjectKey: ProjectKey.nullable(),
    opId: OperationId
  })
  .strict()
export const SetProjectPinnedParams = z
  .object({
    projectKey: ProjectKey,
    pinned: z.boolean(),
    opId: OperationId
  })
  .strict()

export type RecordProjectOpenRequest = z.infer<typeof RecordProjectOpenParams>
export type SetProjectPinnedRequest = z.infer<typeof SetProjectPinnedParams>
