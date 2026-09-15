import { join } from 'node:path'

export const SERVE_UPDATE_REQUEST_FILE = 'request.json'
export const SERVE_UPDATE_RESULT_FILE = 'result.json'
export const SERVE_UPDATE_HELPER_MARKER_FILE = 'helper.json'
/** The app's quit-fence census passed; the helper may stop the unit. */
export const SERVE_UPDATE_CENSUS_OK_FILE = 'census.ok'

export const SERVE_UPDATE_SPOOL_SCHEMA_VERSION = 2
export const SERVE_UPDATE_HELPER_VERSION = 1

export type ServeUpdateRequest = {
  schemaVersion: typeof SERVE_UPDATE_SPOOL_SCHEMA_VERSION
  /** Identifies the serving runtime instance that spooled the request. */
  runtimeId: string
  /** Random per-attempt id echoed in the result; fences a replayed/stale verdict. */
  attemptId: string
  fromVersion: string
  targetVersion: string
  artifactPath: string
  /** Base64 sha512 digest from the release manifest electron-updater verified at download time. */
  sha512: string
  servingPid: number
  unitName: string
}

export type ServeUpdateResult =
  | { phase: 'accepted' }
  | { phase: 'ok'; targetVersion: string }
  | { phase: 'rejected'; reason: string }
  | { phase: 'failed'; reason: string }

export type ServeUpdateHelperMarker = {
  helperVersion: number
  unitName: string
}

/** Null verdict means timeout: the helper never answered inside the poll window. */
export type ServeUpdateVerdict = 'accepted' | 'rejected' | 'failed'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function getRequestPath(spoolDir: string): string {
  return join(spoolDir, SERVE_UPDATE_REQUEST_FILE)
}

export function getResultPath(spoolDir: string): string {
  return join(spoolDir, SERVE_UPDATE_RESULT_FILE)
}

export function getHelperMarkerPath(spoolDir: string): string {
  return join(spoolDir, SERVE_UPDATE_HELPER_MARKER_FILE)
}

export function getCensusOkPath(spoolDir: string): string {
  return join(spoolDir, SERVE_UPDATE_CENSUS_OK_FILE)
}

export function parseServeUpdateResult(value: unknown): ServeUpdateResult | null {
  if (!isRecord(value)) {
    return null
  }
  const { phase, targetVersion, reason } = value
  if (phase === 'accepted') {
    // Pre-quit acknowledgement: the helper has claimed the request and the app may exit.
    return { phase: 'accepted' }
  }
  if (phase === 'ok') {
    return typeof targetVersion === 'string' && targetVersion.length > 0
      ? { phase: 'ok', targetVersion }
      : null
  }
  if (phase === 'rejected' || phase === 'failed') {
    return typeof reason === 'string' && reason.length > 0 ? { phase, reason } : null
  }
  return null
}

export function parseServeUpdateHelperMarker(value: unknown): ServeUpdateHelperMarker | null {
  if (!isRecord(value) || typeof value.helperVersion !== 'number') {
    return null
  }
  const { helperVersion, unitName } = value
  if (!Number.isInteger(helperVersion) || helperVersion <= 0) {
    return null
  }
  if (typeof unitName !== 'string' || unitName.length === 0) {
    return null
  }
  return { helperVersion, unitName }
}
