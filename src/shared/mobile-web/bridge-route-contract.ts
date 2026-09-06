import { z } from 'zod'
import { MobileWebWorkspaceIdSchema } from './workspace-operation-contract'

/** Routes the bridge carries in both directions: the shell restores one on `init`, drives one on a
 * `navigation` frame, and the page reports the one it settled on. Opaque workspace handles only — a
 * host path must never appear here. */
const MobileWebWorkspaceListRouteSchema = z
  .object({
    kind: z.literal('workspaceList'),
    notice: z.literal('worktree-missing').optional()
  })
  .strict()

const MobileWebSessionRouteSchema = z
  .object({
    kind: z.literal('session'),
    workspaceId: MobileWebWorkspaceIdSchema,
    workspaceName: z.string().max(240)
  })
  .strict()

export const MobileWebResumeRouteSchema = z.discriminatedUnion('kind', [
  MobileWebWorkspaceListRouteSchema,
  MobileWebSessionRouteSchema
])

export const MobileWebNavigationRouteSchema = z.discriminatedUnion('kind', [
  MobileWebWorkspaceListRouteSchema,
  MobileWebSessionRouteSchema,
  z
    .object({
      kind: z.literal('tasks'),
      taskSource: z.enum(['github', 'gitlab', 'linear']).optional()
    })
    .strict(),
  z.object({ kind: z.literal('accounts') }).strict(),
  z.object({ kind: z.literal('newWorkspace') }).strict()
])

export type MobileWebNavigationRoute = z.infer<typeof MobileWebNavigationRouteSchema>
export type MobileWebResumeRoute = z.infer<typeof MobileWebResumeRouteSchema>
