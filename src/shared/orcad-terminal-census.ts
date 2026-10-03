/**
 * How many terminals a host's daemon runs, as a client hands it to deploy, rollback and
 * decommission planning. `null` means the daemon could not answer, which is never zero:
 * loss of contact is not evidence of process death (docs/reference/ssh-execution-boundary.md).
 */
import { z } from 'zod'

const CountSchema = z.number().int().nonnegative().nullable()

export const OrcadTerminalCensusSchema = z.object({
  /** Sessions the live daemon owns right now. */
  liveSessions: CountSchema,
  /** Of those, how many started at or after the active version's activation. */
  startedSinceActivation: CountSchema,
  /** Protocol of the daemon that owns those sessions. */
  daemonProtocolVersion: z.number().int().positive().nullable()
})

export type OrcadTerminalCensus = z.infer<typeof OrcadTerminalCensusSchema>

/** RPC a managed orcad answers with its census; clients call it only when advertised. */
export const ORCAD_TERMINAL_CENSUS_METHOD = 'orcad.terminalCensus'

export const OrcadTerminalCensusParamsSchema = z.object({
  /** The active version's activation time, epoch ms; sessions created at or after it count. */
  activatedAt: z.number().finite().nonnegative()
})
