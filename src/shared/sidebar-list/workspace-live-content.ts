import { z } from 'zod'

/** What a workspace's terminals hold right now, as its host counts them; idle ones are absent. */
export const WorkspaceLiveContentSchema = z.object({
  liveTerminalCount: z.number().int().nonnegative(),
  hasAttachedPty: z.boolean()
})

export type WorkspaceLiveContent = z.infer<typeof WorkspaceLiveContentSchema>

export function workspaceLiveContentEqual(
  a: WorkspaceLiveContent,
  b: WorkspaceLiveContent
): boolean {
  return a.liveTerminalCount === b.liveTerminalCount && a.hasAttachedPty === b.hasAttachedPty
}
