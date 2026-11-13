// OWNER-TRANSFER wire types: what the control plane answers when a workspace changes owner, and
// the notices it keeps for the previous owner (GET /v1/team/notices). Mirrors
// cloud/apps/sandbox-control/src/owner-transfer-notices.ts.
import { z } from 'zod'
import { CloudWorkspaceSchema, type CloudWorkspace } from './cloud-workspaces-wire'

const Id = z.string().min(1).max(128)

/**
 * Whether the previous owner will hear about it. `notified` means a notice is waiting for them
 * (they are still in the team) or an email was delivered, not that they have seen it.
 */
export const PreviousOwnerSchema = z.object({
  userId: Id,
  notified: z.boolean(),
  inApp: z.boolean(),
  emailed: z.boolean()
})
export type PreviousOwner = z.infer<typeof PreviousOwnerSchema>

/** PATCH /v1/team/workspaces/:id with a new owner. Older control planes omit `previousOwner`. */
export const OwnerChangeResponseSchema = z.object({
  workspace: CloudWorkspaceSchema,
  previousOwner: PreviousOwnerSchema.optional().catch(undefined)
})
export type OwnerChange = { workspace: CloudWorkspace; previousOwner: PreviousOwner | null }

const Person = z.object({ userId: Id, name: z.string().max(200).nullable() })

export const OwnerChangeNoticeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  kind: z.literal('workspace_owner_changed'),
  workspace: z.object({
    id: Id,
    name: z.string().max(1024).nullable(),
    number: z.number().int().positive().nullable()
  }),
  actor: Person,
  newOwner: Person,
  at: z.number()
})
export type OwnerChangeNotice = z.infer<typeof OwnerChangeNoticeSchema>

/** A kind this desktop does not know is skipped, not a failed read. */
export const OwnerChangeNoticeListSchema = z.object({
  notices: z
    .array(z.unknown())
    .max(200)
    .transform((items) =>
      items.flatMap((item) => {
        const parsed = OwnerChangeNoticeSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      })
    )
})

export const OwnerChangeNoticeDismissedSchema = z.looseObject({ dismissed: z.boolean() })
