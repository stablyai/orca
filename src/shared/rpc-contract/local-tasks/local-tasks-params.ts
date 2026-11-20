import { z } from 'zod'

const Id = z.string().min(1).max(128)
const Line = z.string().max(2000)
const Ids = z.array(Id).max(100)

export const CreateLocalTask = z.object({
  title: z.string().min(1).max(500),
  id: Id.optional(),
  status: Id.optional(),
  labels: z.array(Line).max(100).optional(),
  priority: z.number().int().min(1).max(5).optional(),
  dependsOn: Ids.optional(),
  body: z.string().max(200_000).optional()
})

export const UpdateLocalTask = z.object({
  id: Id,
  patch: z.object({
    title: z.string().min(1).max(500).optional(),
    status: Id.optional(),
    labels: z.array(Line).max(100).optional(),
    priority: z.number().int().min(1).max(5).optional(),
    dependsOn: Ids.optional(),
    blockedReason: Line.nullable().optional(),
    url: Line.nullable().optional()
  })
})

export const ClaimLocalTask = z.object({ id: Id, claimer: Id })
export const ReleaseLocalTask = ClaimLocalTask
export const RenewLocalTask = ClaimLocalTask
