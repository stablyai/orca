import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type {
  RecoverySurface,
  UnresolvedRecoverySurface
} from './web-session-terminal-orphan-recovery-surface'

export type SurfaceRecoveryFingerprintInput = {
  handle: string
  incomingId?: string
  incomingStatus?: string
  incomingPtyId?: string | null
}

type StableSurfaceRecoveryFailure = {
  fingerprint: string
}

type StablePaneResolutionFailure = {
  fingerprint: string
}

type SurfaceInventoryAbsence = {
  fingerprint: string
  observations: number
}

const MAX_CACHED_SURFACE_RESOLUTIONS = 512
const stableSurfaceRecoveryFailures = new Map<string, StableSurfaceRecoveryFailure>()
const MAX_CACHED_PANE_RESOLUTION_FAILURES = 512
const cachedPaneResolutionFailures = new Map<string, StablePaneResolutionFailure>()
const MAX_CACHED_INVENTORY_ABSENCES = 512
const surfaceInventoryAbsences = new Map<string, SurfaceInventoryAbsence>()

function buildSurfaceRecoveryCacheKey(args: {
  environmentId: string
  worktreeId: string
  surfaceKey: string
  expectedEnvironmentPairingRevision?: number
}): string {
  return `${args.environmentId}\0${args.expectedEnvironmentPairingRevision ?? 'unknown'}\0${args.worktreeId}\0${args.surfaceKey}`
}

function buildSurfaceRecoveryFingerprint(
  snapshot: RuntimeMobileSessionTabsResult,
  input: SurfaceRecoveryFingerprintInput
): string {
  return [
    snapshot.publicationEpoch,
    snapshot.snapshotVersion,
    input.handle,
    input.incomingId ?? '',
    input.incomingStatus ?? 'absent',
    input.incomingPtyId ?? ''
  ].join('\0')
}

function surfaceRecoveryCoordinates(args: {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
  surface: RecoverySurface
  expectedEnvironmentPairingRevision?: number
}): { key: string; fingerprint: string } {
  return {
    key: buildSurfaceRecoveryCacheKey({
      environmentId: args.environmentId,
      worktreeId: args.snapshot.worktree,
      surfaceKey: args.surface.surfaceKey,
      expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
    }),
    fingerprint: buildSurfaceRecoveryFingerprint(args.snapshot, {
      handle: args.surface.handle,
      incomingId: args.surface.incoming?.id,
      incomingStatus: args.surface.incoming?.status,
      incomingPtyId: args.surface.incoming?.ptyId
    })
  }
}

/** Returns true when this exact frame already hit a stable adoption/protocol failure. */
export function readStableSurfaceRecoveryFailure(args: {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
  surface: RecoverySurface
  expectedEnvironmentPairingRevision?: number
}): boolean {
  const { key, fingerprint } = surfaceRecoveryCoordinates(args)
  const cached = stableSurfaceRecoveryFailures.get(key)
  if (!cached) {
    return false
  }
  if (cached.fingerprint !== fingerprint) {
    stableSurfaceRecoveryFailures.delete(key)
    return false
  }
  stableSurfaceRecoveryFailures.delete(key)
  stableSurfaceRecoveryFailures.set(key, cached)
  return true
}

export function cacheStableSurfaceRecoveryFailure(args: {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
  surface: RecoverySurface
  expectedEnvironmentPairingRevision?: number
}): void {
  const { key, fingerprint } = surfaceRecoveryCoordinates(args)
  stableSurfaceRecoveryFailures.delete(key)
  stableSurfaceRecoveryFailures.set(key, { fingerprint })
  while (stableSurfaceRecoveryFailures.size > MAX_CACHED_SURFACE_RESOLUTIONS) {
    const oldest = stableSurfaceRecoveryFailures.keys().next().value
    if (typeof oldest !== 'string') {
      return
    }
    stableSurfaceRecoveryFailures.delete(oldest)
  }
}

function buildPaneResolutionFingerprint(
  snapshot: RuntimeMobileSessionTabsResult,
  surface: RecoverySurface | UnresolvedRecoverySurface
): string {
  return [
    snapshot.publicationEpoch,
    snapshot.snapshotVersion,
    surface.expectedPtyId ?? '',
    surface.incoming?.id ?? '',
    surface.incoming?.status ?? 'absent'
  ].join('\0')
}

function inventoryAbsenceCoordinates(args: {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
  surface: RecoverySurface
  expectedEnvironmentPairingRevision?: number
}): { key: string; fingerprint: string } {
  return {
    key: buildSurfaceRecoveryCacheKey({
      environmentId: args.environmentId,
      worktreeId: args.snapshot.worktree,
      surfaceKey: args.surface.surfaceKey,
      expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
    }),
    // Why no publicationEpoch: the fingerprint identifies the *surface* being confirmed absent, not the
    // snapshot that carried it. Folding the epoch in required both observations to come from one
    // publication — which is the same evidence counted twice — and reset the count whenever the host
    // republished, so a host that re-publishes between inventories could never reach two.
    fingerprint: [args.surface.handle, args.surface.expectedPtyId ?? ''].join('\0')
  }
}

/** Returns true after two authoritative inventories omit the same surface identity. */
export function confirmSurfaceInventoryAbsence(args: {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
  surface: RecoverySurface
  expectedEnvironmentPairingRevision?: number
}): boolean {
  const { key, fingerprint } = inventoryAbsenceCoordinates(args)
  const cached = surfaceInventoryAbsences.get(key)
  const observations = cached?.fingerprint === fingerprint ? cached.observations + 1 : 1
  surfaceInventoryAbsences.delete(key)
  surfaceInventoryAbsences.set(key, {
    fingerprint,
    observations: Math.min(observations, 2)
  })
  while (surfaceInventoryAbsences.size > MAX_CACHED_INVENTORY_ABSENCES) {
    const oldest = surfaceInventoryAbsences.keys().next().value
    if (typeof oldest !== 'string') {
      break
    }
    surfaceInventoryAbsences.delete(oldest)
  }
  return observations >= 2
}

export function clearSurfaceInventoryAbsence(args: {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
  surface: RecoverySurface
  expectedEnvironmentPairingRevision?: number
}): void {
  surfaceInventoryAbsences.delete(inventoryAbsenceCoordinates(args).key)
}

/** Returns true when this exact snapshot already produced a stable unsupported/invalid result. */
export function readStablePaneResolutionFailure(args: {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
  surface: RecoverySurface | UnresolvedRecoverySurface
  expectedEnvironmentPairingRevision?: number
}): boolean {
  const key = buildSurfaceRecoveryCacheKey({
    environmentId: args.environmentId,
    worktreeId: args.snapshot.worktree,
    surfaceKey: args.surface.surfaceKey,
    expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
  })
  const fingerprint = buildPaneResolutionFingerprint(args.snapshot, args.surface)
  const cached = cachedPaneResolutionFailures.get(key)
  if (!cached) {
    return false
  }
  if (cached.fingerprint !== fingerprint) {
    cachedPaneResolutionFailures.delete(key)
    return false
  }
  // Keep frequently observed degraded surfaces hot without allowing the map to grow.
  cachedPaneResolutionFailures.delete(key)
  cachedPaneResolutionFailures.set(key, cached)
  return true
}

export function cacheStablePaneResolutionFailure(args: {
  environmentId: string
  snapshot: RuntimeMobileSessionTabsResult
  surface: RecoverySurface | UnresolvedRecoverySurface
  expectedEnvironmentPairingRevision?: number
}): void {
  const key = buildSurfaceRecoveryCacheKey({
    environmentId: args.environmentId,
    worktreeId: args.snapshot.worktree,
    surfaceKey: args.surface.surfaceKey,
    expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
  })
  cachedPaneResolutionFailures.delete(key)
  cachedPaneResolutionFailures.set(key, {
    fingerprint: buildPaneResolutionFingerprint(args.snapshot, args.surface)
  })
  while (cachedPaneResolutionFailures.size > MAX_CACHED_PANE_RESOLUTION_FAILURES) {
    const oldest = cachedPaneResolutionFailures.keys().next().value
    if (typeof oldest !== 'string') {
      return
    }
    cachedPaneResolutionFailures.delete(oldest)
  }
}

export function clearCachedSurfaceResolutions(): void {
  stableSurfaceRecoveryFailures.clear()
  cachedPaneResolutionFailures.clear()
  surfaceInventoryAbsences.clear()
}
