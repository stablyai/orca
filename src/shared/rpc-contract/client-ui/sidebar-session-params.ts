import { z } from 'zod'

/** Sent when the window mounts its list; a new id resets main's Smart latch and retention. */
export const SidebarSessionBeginParams = z.object({ sessionId: z.string().min(1).max(128) })
