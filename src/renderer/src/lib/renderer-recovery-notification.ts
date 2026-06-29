export type RendererRecoveryNotificationReason =
  | 'lazy-chunk-reload'
  | 'lazy-chunk-app-restart'
  | 'memory-pressure-reload'

export type PendingRendererRecoveryNotification = {
  reason: RendererRecoveryNotificationReason
}

type RecoveryNotificationScope = 'session' | 'local'
type StoredRendererRecoveryNotification = PendingRendererRecoveryNotification & {
  createdAtMs: number
}

const STORAGE_VERSION = 1
const MAX_MARKER_AGE_MS = 30 * 60 * 1000
const SESSION_STORAGE_KEY = 'orca:renderer-recovery-notification:session'
const LOCAL_STORAGE_KEY = 'orca:renderer-recovery-notification:local'
const VALID_REASONS = new Set<RendererRecoveryNotificationReason>([
  'lazy-chunk-reload',
  'lazy-chunk-app-restart',
  'memory-pressure-reload'
])

export function markRendererRecoveryNotificationPending(
  reason: RendererRecoveryNotificationReason,
  scope: RecoveryNotificationScope
): void {
  const storage = getRecoveryNotificationStorage(scope)
  if (!storage) {
    return
  }
  try {
    storage.setItem(
      getRecoveryNotificationStorageKey(scope),
      JSON.stringify({ version: STORAGE_VERSION, reason, createdAtMs: Date.now() })
    )
  } catch {
    // Best effort: notification state must never block crash recovery.
  }
}

export function clearRendererRecoveryNotificationPending(
  reason?: RendererRecoveryNotificationReason
): void {
  clearRecoveryNotificationStorage('session', reason)
  clearRecoveryNotificationStorage('local', reason)
}

export function consumePendingRendererRecoveryNotification(): PendingRendererRecoveryNotification | null {
  const local = readRecoveryNotificationStorage('local')
  const session = readRecoveryNotificationStorage('session')
  clearRendererRecoveryNotificationPending()
  return selectPendingRecoveryNotification(local, session)
}

function readRecoveryNotificationStorage(
  scope: RecoveryNotificationScope
): StoredRendererRecoveryNotification | null {
  const storage = getRecoveryNotificationStorage(scope)
  if (!storage) {
    return null
  }
  try {
    const raw = storage.getItem(getRecoveryNotificationStorageKey(scope))
    if (!raw) {
      return null
    }
    const parsed = JSON.parse(raw) as {
      version?: unknown
      reason?: unknown
      createdAtMs?: unknown
    }
    if (parsed.version !== STORAGE_VERSION || !isRendererRecoveryReason(parsed.reason)) {
      return null
    }
    if (!isFreshCreatedAtMs(parsed.createdAtMs)) {
      return null
    }
    return { reason: parsed.reason, createdAtMs: parsed.createdAtMs }
  } catch {
    return null
  }
}

function selectPendingRecoveryNotification(
  local: StoredRendererRecoveryNotification | null,
  session: StoredRendererRecoveryNotification | null
): PendingRendererRecoveryNotification | null {
  if (!local) {
    return session ? { reason: session.reason } : null
  }
  if (!session) {
    return { reason: local.reason }
  }
  // Why: app-restart markers are durable, so a later renderer-refresh marker
  // should not be mislabeled as an older restart recovery.
  const selected = local.createdAtMs >= session.createdAtMs ? local : session
  return { reason: selected.reason }
}

function clearRecoveryNotificationStorage(
  scope: RecoveryNotificationScope,
  reason: RendererRecoveryNotificationReason | undefined
): void {
  const storage = getRecoveryNotificationStorage(scope)
  if (!storage) {
    return
  }
  try {
    if (reason) {
      const pending = readRecoveryNotificationStorage(scope)
      if (pending?.reason !== reason) {
        return
      }
    }
    storage.removeItem(getRecoveryNotificationStorageKey(scope))
  } catch {
    // Best effort: stale notification markers are harmless and self-clearing.
  }
}

function getRecoveryNotificationStorage(scope: RecoveryNotificationScope): Storage | null {
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return scope === 'session' ? window.sessionStorage : window.localStorage
  } catch {
    return null
  }
}

function getRecoveryNotificationStorageKey(scope: RecoveryNotificationScope): string {
  return scope === 'session' ? SESSION_STORAGE_KEY : LOCAL_STORAGE_KEY
}

function isRendererRecoveryReason(value: unknown): value is RendererRecoveryNotificationReason {
  return typeof value === 'string' && VALID_REASONS.has(value as RendererRecoveryNotificationReason)
}

function isFreshCreatedAtMs(value: unknown): value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return false
  }
  const ageMs = Date.now() - value
  return ageMs >= 0 && ageMs <= MAX_MARKER_AGE_MS
}
