import { z } from 'zod'

export const WORKSPACE_LIFECYCLE_KINDS = ['create', 'sleep', 'wake', 'close', 'delete'] as const

export type WorkspaceLifecycleKind = (typeof WORKSPACE_LIFECYCLE_KINDS)[number]

/** A lifecycle command main accepted for a workspace: a hint only, never saved, gone on restart. */
const WorkspaceLifecycleHintSchema = z.object({
  kind: z.enum(WORKSPACE_LIFECYCLE_KINDS),
  /** Commands accepted after this one and still waiting. */
  queuedBehind: z.number(),
  /** The last command's outcome went unconfirmed by its host; the queue waits for proof. */
  paused: z.literal(true).optional()
})

/** Keyed by the workspace's host-qualified key (`hostId|id`). */
export const WorkspaceLifecycleHintsSchema = z.record(z.string(), WorkspaceLifecycleHintSchema)

export type WorkspaceLifecycleHint = z.infer<typeof WorkspaceLifecycleHintSchema>
