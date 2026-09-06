import { createHash, randomBytes } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Records that a macOS update install is in flight for one app bundle.
 *
 * Squirrel's ShipIt refuses to swap a bundle while any instance of it is running, and it
 * matches on bundle path AND bundle id. So this marker is keyed by the bundle being swapped,
 * NOT by userData: a second profile or a rig instance launched from the same bundle blocks the
 * install just as effectively, and Electron's single-instance lock — which is userData-keyed —
 * does not stop it.
 */
export type MacUpdateInstallMarker = {
  schemaVersion: 1
  bundlePath: string
  fromVersion: string
  targetVersion: string
  requestedByPid: number
  /** Kernel-reported process start; optional for markers written by earlier builds. */
  requestedByStartedAtMs?: number
  createdAtMs: number
  /** Random per-attempt token. Two attempts from one process in the same millisecond would
   *  otherwise share a filename, and the loser could be unlinked by the winner's owner. */
  attemptId: string
}

/** How long a marker can describe a live install before we stop believing it. Chosen above the
 *  longest observed ShipIt wait (9m37s) so the gate does not expire while ShipIt is still
 *  patiently waiting — expiring early is what re-opens the race. */
export const MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS = 12 * 60_000

/** Tolerated backwards clock step before a future-dated marker reads as corrupt. */
const CLOCK_SKEW_TOLERANCE_MS = 60_000

/** `<bundle>.app/Contents/MacOS/<exe>` -> `<bundle>.app`, or null when not a bundled mac app. */
export function resolveMacAppBundlePath(executable: string): string | null {
  if (process.platform !== 'darwin') {
    return null
  }
  const appBundlePath = dirname(dirname(dirname(executable)))
  if (!appBundlePath.endsWith('.app')) {
    return null
  }
  // Why canonicalise here: the marker is keyed by this path and the installer probe matches on
  // the path `ps` reports, so a symlinked bundle must resolve to the same spelling in both or
  // they disagree about which app is installing.
  try {
    return realpathSync(appBundlePath)
  } catch {
    return appBundlePath
  }
}

/**
 * Directory holding install markers for one bundle.
 *
 * Why a directory of generation-named files rather than a single file: deletion has to be safe
 * against a concurrent install. Compare-then-unlink is a race — a newer marker written between
 * the comparison and the unlink gets deleted, freeing the next launch to cancel that install.
 * Giving every attempt its own filename means an owner unlinks exactly the file it wrote, and a
 * newer attempt's file is simply a different name that nobody else can remove.
 */
export function getMacUpdateInstallMarkerDir(bundlePath: string): string {
  const key = createHash('sha256').update(bundlePath).digest('hex').slice(0, 16)
  return join(homedir(), 'Library', 'Caches', 'com.stablyai.orca.updates', `install-${key}`)
}

/** File name for one attempt. Unique per (process, moment), so no two owners share a file. */
export function getMacUpdateInstallMarkerFileName(marker: MacUpdateInstallMarker): string {
  return `attempt-${marker.createdAtMs}-${marker.requestedByPid}-${marker.attemptId}.json`
}

/** Name for an attempt whose outcome has been reported; ignored by readers, removed by expiry. */
export function getSettledMacUpdateInstallMarkerFileName(marker: MacUpdateInstallMarker): string {
  return `settled-${marker.createdAtMs}-${marker.requestedByPid}-${marker.attemptId}.json`
}

export function createAttemptId(): string {
  return randomBytes(8).toString('hex')
}

export function getMacUpdateInstallMarkerPath(
  bundlePath: string,
  marker: MacUpdateInstallMarker
): string {
  return join(getMacUpdateInstallMarkerDir(bundlePath), getMacUpdateInstallMarkerFileName(marker))
}

export function isMarkerExpired(
  marker: MacUpdateInstallMarker,
  now: number,
  maxAgeMs: number = MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS
): boolean {
  // Both directions: a backwards clock step would otherwise read as fresh forever.
  return now - marker.createdAtMs > maxAgeMs || marker.createdAtMs > now + 60_000
}

/**
 * The attempt a launch should reason about.
 *
 * Newest-that-is-not-expired, rather than simply newest: a dead newest attempt would otherwise
 * make the gate wait for a version nobody is installing while an older attempt is the one
 * genuinely in flight.
 */
export function selectActiveMarker(
  markers: readonly MacUpdateInstallMarker[],
  now: number,
  maxAgeMs: number = MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS
): MacUpdateInstallMarker | null {
  let active: MacUpdateInstallMarker | null = null
  for (const marker of markers) {
    if (isMarkerExpired(marker, now, maxAgeMs)) {
      continue
    }
    if (!active || marker.createdAtMs > active.createdAtMs) {
      active = marker
    }
  }
  return active
}

/** Pick the newest marker that is both fresh and proven to be in flight. */
export function selectInFlightMarker(
  markers: readonly MacUpdateInstallMarker[],
  now: number,
  isInFlight: (marker: MacUpdateInstallMarker) => boolean,
  maxAgeMs: number = MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS
): MacUpdateInstallMarker | null {
  let active: MacUpdateInstallMarker | null = null
  for (const marker of markers) {
    if (isMarkerExpired(marker, now, maxAgeMs) || !isInFlight(marker)) {
      continue
    }
    if (
      !active ||
      marker.createdAtMs > active.createdAtMs ||
      (marker.createdAtMs === active.createdAtMs && marker.attemptId > active.attemptId)
    ) {
      active = marker
    }
  }
  return active
}

/**
 * Read every valid marker for a bundle. Unreadable or corrupt entries are skipped rather than
 * treated as absence of an install — a marker we cannot parse may belong to a live attempt.
 */
export function readMacUpdateInstallMarkers(
  bundlePath: string,
  read: { list: (dir: string) => readonly string[]; readFile: (path: string) => string }
): MacUpdateInstallMarker[] {
  const dir = getMacUpdateInstallMarkerDir(bundlePath)
  let names: readonly string[]
  try {
    names = read.list(dir)
  } catch {
    return []
  }
  const markers: MacUpdateInstallMarker[] = []
  for (const name of names) {
    // Why skip `settled-`: reconcile renames an attempt it has already reported on, so telemetry
    // is not emitted twice. Renaming by exact name is exactly as race-safe as unlinking by exact
    // name, and it leaves expiry as the only thing that deletes files.
    if (!name.startsWith('attempt-') || !name.endsWith('.json')) {
      continue
    }
    try {
      const parsed = parseMacUpdateInstallMarker(JSON.parse(read.readFile(join(dir, name))))
      // Why drop a foreign bundlePath: the directory is keyed by bundle, so an entry naming a
      // different one is stale or corrupt. Keeping it would let it be selected as the newest and
      // mask a valid attempt for the bundle actually being installed.
      if (parsed && parsed.bundlePath === bundlePath) {
        markers.push(parsed)
      }
    } catch {
      // Skip entries this process cannot read.
    }
  }
  return markers
}

export function parseMacUpdateInstallMarker(value: unknown): MacUpdateInstallMarker | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const state = value as Record<string, unknown>
  // Why trim-checks: a marker whose targetVersion is blank or whitespace can never match a real
  // bundle version, so it would hold the launch gate open for the whole cap.
  // Why an exact shape: any string that cannot equal a bundle version would hold the launch gate
  // open for the entire cap. Orca ships three numeric components with an optional prerelease —
  // 1.4.195 and 1.4.195-hourly.202609012014 — so '1', '1.2', '1.2.3.4' and '1garbage' are all
  // impossible versions and must not pass.
  const isVersion = (v: unknown): boolean =>
    typeof v === 'string' && /^\d+\.\d+\.\d+([-+][0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/.test(v)
  const isBundlePath = (v: unknown): boolean =>
    typeof v === 'string' && v.startsWith('/') && v.endsWith('.app')
  if (
    state.schemaVersion !== 1 ||
    !isBundlePath(state.bundlePath) ||
    !isVersion(state.fromVersion) ||
    !isVersion(state.targetVersion) ||
    !Number.isInteger(state.requestedByPid) ||
    (state.requestedByPid as number) <= 0 ||
    (state.requestedByStartedAtMs !== undefined &&
      (!Number.isInteger(state.requestedByStartedAtMs) ||
        (state.requestedByStartedAtMs as number) <= 0)) ||
    !Number.isInteger(state.createdAtMs) ||
    (state.createdAtMs as number) <= 0 ||
    typeof state.attemptId !== 'string' ||
    !/^[0-9a-f]{16}$/.test(state.attemptId)
  ) {
    return null
  }
  return state as MacUpdateInstallMarker
}

/**
 * Is an attempt still in flight?
 *
 * The single decision core both gates use, so they cannot disagree about what "installing" means.
 *
 * Two authorities, each answering the question it can actually answer:
 *  - freshness (the clock) bounds how long any attempt may be believed;
 *  - phase asks whether the installer can be running YET or is running NOW. Before the writer
 *    exits, ShipIt cannot have spawned — the writer's own exit is what lets it start — so a live
 *    writer means pre-spawn, not absence. After the writer exits, only ShipIt liveness can say.
 *
 * This is why the writer pid must never be a deletion credential: the writer exiting is the
 * NORMAL state of a live install, so "writer is gone" says nothing about whether the swap is done.
 */
export function isAttemptInFlight(input: {
  marker: MacUpdateInstallMarker | null
  now: number
  shipItLiveness: 'live' | 'unverifiable' | 'exited'
  writerAlive: boolean
  maxAgeMs?: number
}): boolean {
  const { marker, now, shipItLiveness, writerAlive } = input
  if (!marker || isMarkerExpired(marker, now, input.maxAgeMs)) {
    return false
  }
  // Pre-spawn: the writer has not exited, so the installer cannot have started yet.
  if (writerAlive) {
    return true
  }
  return shipItLiveness === 'live'
}

export type MacUpdateLaunchDecision =
  /** No install is in flight; launch normally. */
  | 'open'
  /** The marker is stale, corrupt, or already satisfied; delete it, then launch normally. */
  | 'clear-and-open'
  /** An install is in flight; wait for the swap instead of becoming the instance that cancels it. */
  | 'wait'

/**
 * Decide whether launching this bundle right now would cancel an in-flight update.
 *
 * Pure so every strand-the-user case is a table test: the cost of a wrong 'wait' is a user
 * locked out of their own app, so every uncertain input resolves toward opening.
 */
export function decideMacUpdateLaunch(input: {
  marker: MacUpdateInstallMarker | null
  bundlePath: string
  bundleVersion: string | null
  now: number
  maxAgeMs?: number
}): MacUpdateLaunchDecision {
  const { marker, bundlePath, bundleVersion, now } = input
  const maxAgeMs = input.maxAgeMs ?? MAC_UPDATE_INSTALL_MARKER_MAX_AGE_MS
  if (!marker) {
    return 'open'
  }
  // A marker for a different bundle says nothing about this one.
  if (marker.bundlePath !== bundlePath) {
    return 'clear-and-open'
  }
  // Why both directions: a backwards clock step would otherwise read as fresh-forever.
  if (marker.createdAtMs > now + CLOCK_SKEW_TOLERANCE_MS) {
    return 'clear-and-open'
  }
  if (now - marker.createdAtMs > maxAgeMs) {
    return 'clear-and-open'
  }
  // The swap already landed; ShipIt relaunches the app itself, so the caller must attach rather
  // than blindly launch a second instance.
  if (bundleVersion !== null && bundleVersion === marker.targetVersion) {
    return 'clear-and-open'
  }
  return 'wait'
}
