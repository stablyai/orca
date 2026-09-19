import { z } from 'zod'

export const OrcadTerminalCensusSchema = z.object({
  liveSessions: z.number().int().nonnegative().nullable(),
  startedSinceActivation: z.number().int().nonnegative().nullable()
})

export type OrcadTerminalCensus = z.infer<typeof OrcadTerminalCensusSchema>
