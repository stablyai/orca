import { join } from 'node:path'

export const SERVE_UPDATE_SPOOL_DIR = '/var/lib/orca-server-update'
export const SERVE_UPDATE_REQUEST_FILE = 'request.json'
export const SERVE_UPDATE_RESULT_FILE = 'result.json'
export const SERVE_UPDATE_HELPER_MARKER_FILE = 'helper.json'

export const SERVE_UPDATE_SPOOL_SCHEMA_VERSION = 2

export type ServeUpdateRequest = {
  schemaVersion: typeof SERVE_UPDATE_SPOOL_SCHEMA_VERSION
  /** Echoed in the result so the app binds the verdict to THIS install attempt. */
  runtimeId: string
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

export type ServeUpdateVerdict = 'accepted' | 'rejected' | 'failed' | 'timeout'

export function getRequestPath(spoolDir: string): string {
  return join(spoolDir, SERVE_UPDATE_REQUEST_FILE)
}

export function getResultPath(spoolDir: string): string {
  return join(spoolDir, SERVE_UPDATE_RESULT_FILE)
}

export function getHelperMarkerPath(spoolDir: string): string {
  return join(spoolDir, SERVE_UPDATE_HELPER_MARKER_FILE)
}

export function parseServeUpdateRequest(value: unknown): ServeUpdateRequest | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const state = value as Record<string, unknown>
  if (
    state.schemaVersion !== SERVE_UPDATE_SPOOL_SCHEMA_VERSION ||
    typeof state.runtimeId !== 'string' ||
    state.runtimeId.length === 0 ||
    typeof state.fromVersion !== 'string' ||
    state.fromVersion.length === 0 ||
    typeof state.targetVersion !== 'string' ||
    state.targetVersion.length === 0 ||
    typeof state.artifactPath !== 'string' ||
    typeof state.sha512 !== 'string' ||
    state.sha512.length === 0 ||
    !Number.isInteger(state.servingPid) ||
    (state.servingPid as number) <= 0 ||
    typeof state.unitName !== 'string' ||
    state.unitName.length === 0
  ) {
    return null
  }
  return state as ServeUpdateRequest
}

export function parseServeUpdateResult(value: unknown): ServeUpdateResult | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const state = value as Record<string, unknown>
  if (state.phase === 'accepted') {
    // Pre-quit acknowledgement: the helper has claimed the request and the app may exit.
    return { phase: 'accepted' }
  }
  if (state.phase === 'ok') {
    return typeof state.targetVersion === 'string' && state.targetVersion.length > 0
      ? { phase: 'ok', targetVersion: state.targetVersion }
      : null
  }
  if (state.phase === 'rejected' || state.phase === 'failed') {
    return typeof state.reason === 'string' && state.reason.length > 0
      ? { phase: state.phase, reason: state.reason }
      : null
  }
  return null
}

export function parseServeUpdateHelperMarker(value: unknown): ServeUpdateHelperMarker | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const state = value as Record<string, unknown>
  if (
    !Number.isInteger(state.helperVersion) ||
    (state.helperVersion as number) <= 0 ||
    typeof state.unitName !== 'string' ||
    state.unitName.length === 0
  ) {
    return null
  }
  return state as ServeUpdateHelperMarker
}
