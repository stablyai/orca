import { z } from 'zod'

const WorkspaceCreationSchema = z.object({
  repoId: z.string(),
  /** Named once the host persisted the workspace, before it announces it. A reader that lists this
   *  workspace shows it instead of the creation, so completion never shows both or neither. */
  worktreeId: z.string().optional()
})

/** Creations the host is running, keyed by creationId. Preflight the window runs before asking
 *  the host stays in the window's own pending layer. */
export const WorkspaceCreationsSnapshotSchema = z.object({
  revision: z.number(),
  creations: z.record(z.string(), WorkspaceCreationSchema)
})

export type WorkspaceCreation = z.infer<typeof WorkspaceCreationSchema>
export type WorkspaceCreationsSnapshot = z.infer<typeof WorkspaceCreationsSnapshotSchema>
