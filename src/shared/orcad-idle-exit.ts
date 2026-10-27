/** Managed SSH orcad stops after 15 unused minutes like the relay; the next connect restarts it. */
import { z } from 'zod'

/** Test-only quiet period; a client forwards it to the servers it launches. */
export const ORCAD_E2E_IDLE_TIMEOUT_ENV = 'ORCA_E2E_ORCAD_IDLE_TIMEOUT_MS'
export const ORCAD_IDLE_EXIT_TIMEOUT_MS = 15 * 60_000
const ORCAD_E2E_IDLE_TIMEOUT_MAX_MS = 60 * 60_000

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

/**
 * In a WSL distro's data root (`~/.orca`): orcad's pid, written on an idle stop that left no
 * terminal daemon. The distro holder ends once that pid exits, so WSL may stop the idle distro.
 */
export const ORCAD_WSL_HOLDER_RELEASE_FILENAME = 'wsl-holder-release'
