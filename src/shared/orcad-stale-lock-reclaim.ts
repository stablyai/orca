/** Explicit lock recovery for cases automatic startup cannot judge, such as shared-home reboot (#32177).
 * Dependency-free so clients, CLI and launcher share the command/result. */
import { quotePosixShellUnlessPlain } from './shell-argument-quoting'

export const ORCAD_RECLAIM_STALE_LOCK_FLAG = '--reclaim-stale-lock'
export const ORCAD_STALE_LOCK_DATA_ROOT_FLAG = '--data-root'
/** Pin confirmation to dry-run evidence. Clients probe this flag in bundles; reclaim alone cannot confirm safely. */
export const ORCAD_STALE_LOCK_EXPECT_NONCE_FLAG = '--expect-nonce'

/** `--json` prints one of these; the exit code names the status too. */
export type OrcadStaleLockReclaimStatus = 'none' | 'eligible' | 'refused' | 'reclaimed'

export type OrcadStaleLockEvidence = {
  pid: number
  host: string
  bootId: string
  currentBootId: string
  ageMinutes: number
  /** The record's own nonce, for `--expect-nonce`; absent from builds before the pin. */
  nonce?: string
}

// Why `none` is not 0: a command pointed at the wrong data root must never read as a recovery.
export const ORCAD_STALE_LOCK_RECLAIM_EXIT_CODES: Record<OrcadStaleLockReclaimStatus, number> = {
  reclaimed: 0,
  refused: 1,
  eligible: 2,
  none: 4
}

/** Managed hosts lack orca/orcad on PATH, so pasteable hints must name the holder’s runtime, entry and data root. */
export type OrcadReclaimHintRuntime = { execPath: string; entry: string | undefined }

export function orcadStaleLockReclaimCommand(
  dataRoot: string,
  runtime: OrcadReclaimHintRuntime | null
): string {
  const program = runtime?.entry
    ? `${quotePosixShellUnlessPlain(runtime.execPath)} ${quotePosixShellUnlessPlain(runtime.entry)}`
    : 'orca serve'
  return `${program} ${ORCAD_RECLAIM_STALE_LOCK_FLAG} ${ORCAD_STALE_LOCK_DATA_ROOT_FLAG} ${quotePosixShellUnlessPlain(dataRoot)}`
}
