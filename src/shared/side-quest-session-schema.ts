import { z } from 'zod'
import {
  SIDE_QUEST_PROVIDERS,
  SIDE_QUEST_SESSION_STATUSES,
  type SideQuestSessionReference
} from './side-quest-types'

export const sideQuestSessionReferenceSchema: z.ZodType<SideQuestSessionReference> = z.object({
  id: z.string().min(1),
  provider: z.enum(SIDE_QUEST_PROVIDERS),
  providerThreadId: z.string().min(1).nullable(),
  status: z.enum(SIDE_QUEST_SESSION_STATUSES),
  error: z.string().nullable(),
  createdAt: z.number().finite().nonnegative(),
  updatedAt: z.number().finite().nonnegative()
})
