/**
 * Idle exit for an orcad a client launched over SSH, matching the relay: a host nobody has
 * used for 15 minutes stops its server, and the next connect starts it again.
 */
import { z } from 'zod'

/**
 * Set only by a client's managed launch. Enables idle exit and names the host's activation
 * fence, so an update or rollback in flight keeps the server up. User-started servers never
 * carry it.
 */
export const ORCAD_MANAGED_ACTIVATION_ROOT_ENV = 'ORCA_ORCAD_MANAGED_ACTIVATION_ROOT'
/** Test-only quiet period; a client forwards it to the servers it launches. */
export const ORCAD_E2E_IDLE_TIMEOUT_ENV = 'ORCA_E2E_ORCAD_IDLE_TIMEOUT_MS'
export const ORCAD_IDLE_EXIT_TIMEOUT_MS = 15 * 60_000
const ORCAD_E2E_IDLE_TIMEOUT_MAX_MS = 60 * 60_000

/** The bounded test override, or null when unset or out of range. */
export function readOrcadE2EIdleTimeoutMs(env: NodeJS.ProcessEnv): number | null {
  const raw = env[ORCAD_E2E_IDLE_TIMEOUT_ENV]
  const value = raw ? Number(raw) : Number.NaN
  return Number.isSafeInteger(value) && value >= 1 && value <= ORCAD_E2E_IDLE_TIMEOUT_MAX_MS
    ? value
    : null
}

/** Written to the data root just before an idle stop; the next start reports and clears it. */
export const ORCAD_IDLE_STOP_RECORD_FILENAME = 'orcad-idle-stop.json'

export const OrcadIdleStopRecordSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('orcad_idle_stop'),
  pid: z.number().int().positive(),
  version: z.string().max(255),
  quietSince: z.iso.datetime({ offset: true }),
  stoppedAt: z.iso.datetime({ offset: true }),
  idleTimeoutMs: z.number().int().positive()
})

export type OrcadIdleStopRecord = z.infer<typeof OrcadIdleStopRecordSchema>
