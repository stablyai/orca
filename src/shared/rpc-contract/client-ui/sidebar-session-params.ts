import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** Sent when the window mounts its list; a new id resets main's Smart latch and retention. */
export const SidebarSessionBeginParams = lazyZodSchema(() =>
  z.object({ sessionId: z.string().min(1).max(128) })
)
