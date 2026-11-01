import { z } from 'zod'

const WorkspaceCreationSchema = z.object({
  repoId: z.string(),
  /** Set after persistence, before announcement; readers listing this workspace replace its creation without a gap or duplicate. */
  worktreeId: z.string().optional()
})

/** Host-running creations by creationId; window preflight stays in its pending layer. */
export const WorkspaceCreationsSnapshotSchema = z.object({
  revision: z.number(),
  creations: z.record(z.string(), WorkspaceCreationSchema)
})

export type WorkspaceCreation = z.infer<typeof WorkspaceCreationSchema>
export type WorkspaceCreationsSnapshot = z.infer<typeof WorkspaceCreationsSnapshotSchema>
