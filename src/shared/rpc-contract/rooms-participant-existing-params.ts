import { z } from 'zod'

import { HarnessAgent } from './rooms-schemas'

export const RoomsParticipantsExistingParams = z
  .object({
    worktreeId: z.string().trim().min(1).max(1024),
    agent: HarnessAgent,
    machineStreaming: z.boolean().optional()
  })
  .strict()
