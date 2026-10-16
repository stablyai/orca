import { z } from 'zod'
import { OrcadTerminalCensusSchema } from './orcad-terminal-census'

export const ORCAD_RESTART_ADMISSION_METHOD = 'orcad.restartAdmission'
export const OrcadRestartAdmissionParamsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('reserve'), activatedAt: z.number().finite().nonnegative(), force: z.boolean().optional() }),
  z.object({ action: z.literal('commit'), token: z.string().min(1) }),
  z.object({ action: z.literal('release'), token: z.string().min(1) })
])
export const OrcadRestartAdmissionResultSchema = z.object({
  status: z.enum(['reserved', 'defer', 'committed', 'released']),
  token: z.string().optional(),
  census: OrcadTerminalCensusSchema.optional(),
  reason: z.string().optional()
})
export type OrcadRestartAdmissionParams = z.infer<typeof OrcadRestartAdmissionParamsSchema>
export type OrcadRestartAdmissionResult = z.infer<typeof OrcadRestartAdmissionResultSchema>
