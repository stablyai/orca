import { z } from 'zod'

/** A submission's answered turn as published. `via` is a string, as `dispatchState` is: a newer
 *  host may name another way of joining. null: the host recorded no turn. */
export const AgentJournalAnsweredTurnSchema = z
  .object({ turnItemId: z.string().min(1), via: z.string().min(1) })
  .nullable()
