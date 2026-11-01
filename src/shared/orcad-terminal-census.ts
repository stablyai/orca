/** Terminal census for lifecycle planning; null is unverifiable, never zero. Lost contact cannot prove process death
 * (docs/reference/ssh-execution-boundary.md). */
import { z } from 'zod'

const CountSchema = z.number().int().nonnegative().nullable()

export const OrcadTerminalCensusSchema = z.object({
  /** Sessions the live daemon owns right now. */
  liveSessions: CountSchema,
  /** Of those, how many started at or after the active version's activation. */
  startedSinceActivation: CountSchema,
  /** Protocol of the daemon that owns those sessions; null unless exactly one generation owns them. */
  daemonProtocolVersion: z.number().int().positive().nullable(),
  /** Protocol of every daemon generation owning those sessions; absent on older hosts. */
  daemonProtocolVersions: z.array(z.number().int().positive()).optional(),
  /** In-process fallback sessions end with orcad, unlike daemon sessions; absent on older hosts. */
  inProcessSessions: CountSchema.optional(),
  /** Admission-fence expiry, epoch ms; 0 means reopened. Absence never proves older servers fenced admission. */
  admissionClosedUntil: z.number().finite().nonnegative().optional()
})

export type OrcadTerminalCensus = z.infer<typeof OrcadTerminalCensusSchema>

/** A daemon that could not answer: unknown, never zero. */
export const UNVERIFIABLE_ORCAD_TERMINAL_CENSUS: Readonly<OrcadTerminalCensus> = Object.freeze({
  liveSessions: null,
  startedSinceActivation: null,
  daemonProtocolVersion: null
})

/** The longest a census may close terminal admission; the stop that follows takes seconds. */
export const ORCAD_TERMINAL_ADMISSION_MAX_FENCE_MS = 5 * 60_000

/** What an update's last census asks for; it lapses on its own if the desktop never returns. */
export const ORCAD_UPDATE_ADMISSION_FENCE_MS = 60_000

/** How long after its recount an update may still send the stop: the fence, less signal latency. */
export const ORCAD_UPDATE_ADMISSION_STOP_BY_MS = ORCAD_UPDATE_ADMISSION_FENCE_MS - 15_000

/** RPC a managed orcad answers with its census; clients call it only when advertised. */
export const ORCAD_TERMINAL_CENSUS_METHOD = 'orcad.terminalCensus'

export const OrcadTerminalCensusParamsSchema = z.object({
  /** The active version's activation time, epoch ms; sessions created at or after it count. */
  activatedAt: z.number().finite().nonnegative(),
  /** Before restart, release unused finished automation terminals; older servers ignore this optional request. */
  releaseFinishedAutomationTerminals: z.literal(true).optional(),
  /** Fence new terminals before the final census/stop; 0 reopens. Older servers ignore this optional request. */
  closeAdmissionForMs: z.number().int().min(0).max(ORCAD_TERMINAL_ADMISSION_MAX_FENCE_MS).optional()
})
