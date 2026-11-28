import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** Host-counted terminal content; idle workspaces are absent. */
export const WorkspaceLiveContentSchema = lazyZodSchema(() =>
  z.object({
    liveTerminalCount: z.number().int().nonnegative(),
    hasAttachedPty: z.boolean()
  })
)

export type WorkspaceLiveContent = z.infer<typeof WorkspaceLiveContentSchema>

export function workspaceLiveContentEqual(
  a: WorkspaceLiveContent,
  b: WorkspaceLiveContent
): boolean {
  return a.liveTerminalCount === b.liveTerminalCount && a.hasAttachedPty === b.hasAttachedPty
}
