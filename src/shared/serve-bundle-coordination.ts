/**
 * The record a desktop install and `orca serve --supervise` share to park a supervised server
 * while macOS replaces the app bundle both run from. Lives outside the bundle, keyed by its path.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** launchd label prefix `orca serve service install` writes; only those supervisors register. */
export const SERVE_LAUNCHD_LABEL_PREFIX = 'com.stablyai.orca.serve'
export const SERVE_COORDINATION_PROTOCOL = 1
/** A registration this stale belongs to a supervisor that is gone or wedged. */
export const SERVE_SUPERVISOR_HEARTBEAT_STALE_MS = 15_000
export const SERVE_SUPERVISOR_HEARTBEAT_MS = 3_000
/** How long the installer waits for every parked supervisor to stop its server. */
export const SERVE_PARK_ACK_WAIT_MS = 60_000
/** A park the installer never committed or released ends on its own after this. */
export const SERVE_PARK_DEADLINE_MS = 2 * 60_000
/** A committed install that never changed the bundle is treated as cancelled after this. */
export const SERVE_COMMIT_DEADLINE_MS = 10 * 60_000

export type ServeSupervisorRegistration = {
  protocol: 1
  pid: number
  childPid: number | null
  heartbeatAt: number
  label: string
}

export type ServeParkRecord = {
  schemaVersion: 1
  attemptId: string
  installerPid: number
  phase: 'park' | 'commit' | 'unpark'
  createdAt: number
  parkDeadlineAt: number
  commitDeadlineAt: number | null
  /** Info.plist identity when the park began: a change proves the install happened. */
  bundleBefore: string
  supervisorPids: number[]
}

/** Electron's default macOS userData base, shared by every profile of one user. */
export function macCoordinationRoot(homeDir: string): string {
  return join(homeDir, 'Library', 'Application Support', 'orca')
}

export function bundleCoordinationDir(realBundlePath: string, macUserDataRoot: string): string {
  const key = createHash('sha256').update(realBundlePath).digest('hex').slice(0, 32)
  return join(macUserDataRoot, 'bundle-coordination', key)
}

export const supervisorsDir = (dir: string): string => join(dir, 'supervisors')
export const parkRecordPath = (dir: string): string => join(dir, 'park.json')
export const acksDir = (dir: string): string => join(dir, 'acks')
export const ackFileName = (attemptId: string, pid: number): string => `${attemptId}.${pid}.json`

export function isServeSupervisorLabel(label: string | undefined): label is string {
  return (
    typeof label === 'string' &&
    (label === SERVE_LAUNCHD_LABEL_PREFIX || label.startsWith(`${SERVE_LAUNCHD_LABEL_PREFIX}.`))
  )
}

const isPid = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

export function parseServeSupervisorRegistration(
  value: unknown
): ServeSupervisorRegistration | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  if (
    !('protocol' in value) ||
    value.protocol !== SERVE_COORDINATION_PROTOCOL ||
    !('pid' in value) ||
    !isPid(value.pid) ||
    !('childPid' in value) ||
    (value.childPid !== null && !isPid(value.childPid)) ||
    !('heartbeatAt' in value) ||
    typeof value.heartbeatAt !== 'number' ||
    !('label' in value) ||
    !isServeSupervisorLabel(typeof value.label === 'string' ? value.label : undefined)
  ) {
    return null
  }
  return {
    protocol: 1,
    pid: value.pid,
    childPid: value.childPid,
    heartbeatAt: value.heartbeatAt,
    label: String(value.label)
  }
}

export function parseServeParkRecord(value: unknown): ServeParkRecord | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  if (
    !('schemaVersion' in value) ||
    value.schemaVersion !== 1 ||
    !('attemptId' in value) ||
    typeof value.attemptId !== 'string' ||
    value.attemptId.length === 0 ||
    !('installerPid' in value) ||
    !isPid(value.installerPid) ||
    !('phase' in value) ||
    (value.phase !== 'park' && value.phase !== 'commit' && value.phase !== 'unpark') ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'number' ||
    !('parkDeadlineAt' in value) ||
    typeof value.parkDeadlineAt !== 'number' ||
    !('commitDeadlineAt' in value) ||
    (value.commitDeadlineAt !== null && typeof value.commitDeadlineAt !== 'number') ||
    !('bundleBefore' in value) ||
    typeof value.bundleBefore !== 'string' ||
    !('supervisorPids' in value) ||
    !Array.isArray(value.supervisorPids)
  ) {
    return null
  }
  return {
    schemaVersion: 1,
    attemptId: value.attemptId,
    installerPid: value.installerPid,
    phase: value.phase,
    createdAt: value.createdAt,
    parkDeadlineAt: value.parkDeadlineAt,
    commitDeadlineAt: value.commitDeadlineAt,
    bundleBefore: value.bundleBefore,
    supervisorPids: value.supervisorPids.filter(isPid)
  }
}

export function isLiveRegistration(
  registration: ServeSupervisorRegistration,
  now: number
): boolean {
  return now - registration.heartbeatAt < SERVE_SUPERVISOR_HEARTBEAT_STALE_MS
}

/**
 * Whether a supervisor must keep its server stopped. Every way out is evidence or a deadline, so
 * a crashed installer or supervisor never leaves the service parked for good.
 */
export function decideServeParkHold(
  record: ServeParkRecord | null,
  facts: { now: number; installerAlive: boolean; bundleNow: string }
): 'hold' | 'release' {
  if (!record || record.phase === 'unpark') {
    return 'release'
  }
  if (record.phase === 'park') {
    return facts.installerAlive && facts.now < record.parkDeadlineAt ? 'hold' : 'release'
  }
  // Committed: the installer quits into ShipIt by design, so its death proves nothing.
  if (facts.bundleNow !== record.bundleBefore) {
    return 'release'
  }
  return record.commitDeadlineAt !== null && facts.now < record.commitDeadlineAt
    ? 'hold'
    : 'release'
}

/** Same-user liveness; EPERM still means the process exists. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

export const bundleInfoPlistPath = (bundlePath: string): string =>
  join(bundlePath, 'Contents', 'Info.plist')

/** ShipIt swaps the whole .app, so Info.plist size or mtime changes even for a same-version reinstall. */
export function formatBundleIdentity(stat: { size: number; mtimeMs: number } | null): string {
  return stat ? `${stat.size}:${Math.trunc(stat.mtimeMs)}` : 'missing'
}
