/**
 * `--reclaim-stale-lock`: the explicit recovery for an orcad instance lock that no automatic start
 * may judge, such as one on a shared home after a reboot (#32177). Dependency-free so the CLI,
 * orcad's launcher and clients can all name it and read its result.
 */
import { quotePosixShellUnlessPlain } from './shell-argument-quoting'

export const ORCAD_RECLAIM_STALE_LOCK_FLAG = '--reclaim-stale-lock'
export const ORCAD_STALE_LOCK_DATA_ROOT_FLAG = '--data-root'
/**
 * Pins `--yes` to the record a dry run showed. Clients also grep a slot's bundle for it: a build
 * that knows it can be confirmed safely, while one that only knows the reclaim flag cannot.
 */
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

/**
 * A command the user can paste on the holder's machine, naming this data root. An orcad names its
 * own runtime and entry, since managed hosts have neither `orca` nor `orcad` on PATH.
 */
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
