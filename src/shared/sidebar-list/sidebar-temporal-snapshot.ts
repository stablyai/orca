import { z } from 'zod'

/** Workspaces "Hide sleeping" keeps through a rebind gap; null while sleeping ones are shown. */
const RetentionSchema = z.object({
  retainedIds: z.array(z.string()),
  retentionDecidedAt: z.number()
})

export const SidebarTemporalSnapshotSchema = z.object({
  revision: z.number(),
  /** The list session the window last began; null until one begins (a headless host). */
  sessionId: z.string().nullable(),
  retention: RetentionSchema.nullable()
})

export type SidebarRetention = z.infer<typeof RetentionSchema>
export type SidebarTemporalSnapshot = z.infer<typeof SidebarTemporalSnapshotSchema>
