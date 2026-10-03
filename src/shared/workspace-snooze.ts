import { z } from 'zod'

/**
 * A snoozed workspace is hidden until the first wake condition fires. Flat optional
 * conditions rather than a tagged union: an older reader ignores a condition it does
 * not know and still treats the workspace as snoozed.
 */
export const WorkspaceSnoozeSchema = z.object({
  snoozedAt: z.number().finite(),
  wakeAt: z.number().finite().optional(),
  afterSession: z
    .object({
      worktreeId: z.string().min(1),
      paneKey: z.string().min(1)
    })
    .optional()
})

export type WorkspaceSnooze = z.infer<typeof WorkspaceSnoozeSchema>

export function isWorkspaceSnoozed(workspace: { snooze?: WorkspaceSnooze | null }): boolean {
  return workspace.snooze != null
}

export function isWorkspaceSnoozeDue(snooze: WorkspaceSnooze, now: number): boolean {
  return snooze.wakeAt !== undefined && snooze.wakeAt <= now
}

/** Parses a persisted value, dropping anything malformed so a bad record reads as awake. */
export function parseStoredWorkspaceSnooze(raw: unknown): WorkspaceSnooze | undefined {
  const parsed = WorkspaceSnoozeSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}
