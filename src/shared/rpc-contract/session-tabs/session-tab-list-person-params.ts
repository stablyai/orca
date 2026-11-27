// Whose tab list a session.tabs read or close names on a shared agent's Home.
import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

/** The owner's list, or a teammate's by account. Absent, the caller's own. Watching a list writes
 *  nothing to it or to anyone's focus. */
export const SessionTabListPerson = lazyZodSchema(() =>
  z.union([z.literal('owner'), z.object({ accountId: z.string().min(1).max(256) })])
)
