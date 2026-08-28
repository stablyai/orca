type SnapshotCapability = { id: string; authoritative: boolean | null }
type SnapshotCapabilityResolver = (ids: string[]) => Promise<SnapshotCapability[]>
type SnapshotCapabilityTab = { id: string; ptyId?: string | null }
type SnapshotCapabilityBindingState = {
  tabsByWorktree: Readonly<Record<string, readonly SnapshotCapabilityTab[]>>
  ptyIdsByTabId: Readonly<Record<string, readonly string[]>>
  pendingReconnectPtyIdByTabId?: Readonly<Record<string, string>>
  terminalLayoutsByTabId?: Readonly<
    Record<string, { ptyIdsByLeafId?: Readonly<Record<string, string>> }>
  >
}

const authoritativeSnapshotByPtyId = new Map<string, boolean>()
const unknownCapabilityRetryAtByPtyId = new Map<string, number>()
const unknownCapabilityAttemptsByPtyId = new Map<string, number>()
const UNKNOWN_CAPABILITY_RETRY_MS = 1_000
const UNKNOWN_CAPABILITY_MAX_RETRY_MS = 30_000
/** 1/2/4/8/16/30/30 s — ~91 s of daemon-startup grace, then a slow re-ask. */
const UNKNOWN_CAPABILITY_MAX_ATTEMPTS = 8
// Why re-askable: a permanent settle turned a slow daemon start into
// session-long eviction exemption for every local pty — force-park could free
// nothing until app restart. Unknown stays exempt (pane stays mounted), but a
// recovered daemon is consulted again within one slow cycle.
const SETTLED_UNKNOWN_REASK_MS = 5 * 60_000
const CAPABILITY_RESOLUTION_TIMEOUT_MS = 1_000
let lastSynchronizedLivePtyIds: readonly string[] | null = null
let earliestUnknownCapabilityRetryAtMs = Number.POSITIVE_INFINITY
let synchronizationGeneration = 0
let capabilityRevision = 0
const capabilityRevisionListeners = new Set<() => void>()

function publishCapabilityChange(): void {
  capabilityRevision += 1
  for (const listener of capabilityRevisionListeners) {
    listener()
  }
}

export function subscribeTerminalProviderSnapshotCapability(listener: () => void): () => void {
  capabilityRevisionListeners.add(listener)
  return () => capabilityRevisionListeners.delete(listener)
}

export function getTerminalProviderSnapshotCapabilityRevision(): number {
  return capabilityRevision
}

export function collectTerminalProviderSnapshotPtyIds(
  state: SnapshotCapabilityBindingState
): string[] {
  const ids = new Set<string>()
  for (const worktreeTabs of Object.values(state.tabsByWorktree)) {
    for (const tab of worktreeTabs) {
      if (tab.ptyId) {
        ids.add(tab.ptyId)
      }
      for (const ptyId of state.ptyIdsByTabId[tab.id] ?? []) {
        ids.add(ptyId)
      }
    }
  }
  for (const ptyId of Object.values(state.pendingReconnectPtyIdByTabId ?? {})) {
    ids.add(ptyId)
  }
  for (const layout of Object.values(state.terminalLayoutsByTabId ?? {})) {
    for (const ptyId of Object.values(layout.ptyIdsByLeafId ?? {})) {
      ids.add(ptyId)
    }
  }
  return [...ids]
}

function refreshEarliestUnknownCapabilityRetry(): void {
  earliestUnknownCapabilityRetryAtMs = Number.POSITIVE_INFINITY
  for (const retryAtMs of unknownCapabilityRetryAtByPtyId.values()) {
    earliestUnknownCapabilityRetryAtMs = Math.min(earliestUnknownCapabilityRetryAtMs, retryAtMs)
  }
}

// Unknown routes decay to a slow cadence after the startup ladder — never a
// permanent verdict, which the eviction-exemption path would inherit for life.
function backOffUnknownCapability(ptyId: string, nowMs: number): void {
  const attempts = Math.min(
    (unknownCapabilityAttemptsByPtyId.get(ptyId) ?? 0) + 1,
    UNKNOWN_CAPABILITY_MAX_ATTEMPTS
  )
  unknownCapabilityAttemptsByPtyId.set(ptyId, attempts)
  unknownCapabilityRetryAtByPtyId.set(
    ptyId,
    nowMs +
      (attempts >= UNKNOWN_CAPABILITY_MAX_ATTEMPTS
        ? SETTLED_UNKNOWN_REASK_MS
        : Math.min(
            UNKNOWN_CAPABILITY_RETRY_MS * 2 ** (attempts - 1),
            UNKNOWN_CAPABILITY_MAX_RETRY_MS
          ))
  )
}

function unknownCapabilityRetryDelayMs(nowMs: number): number | null {
  return earliestUnknownCapabilityRetryAtMs === Number.POSITIVE_INFINITY
    ? null
    : Math.max(0, earliestUnknownCapabilityRetryAtMs - nowMs)
}

async function resolveSnapshotCapabilityBatch(
  resolve: SnapshotCapabilityResolver,
  batch: string[]
): Promise<SnapshotCapability[] | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      resolve(batch),
      new Promise<null>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(null), CAPABILITY_RESOLUTION_TIMEOUT_MS)
      })
    ])
  } finally {
    clearTimeout(timeout)
  }
}

export async function synchronizeTerminalProviderSnapshotCapabilities(
  livePtyIds: readonly string[],
  resolveCapabilities?: SnapshotCapabilityResolver,
  observedAtMs?: number
): Promise<number | null> {
  if (
    livePtyIds === lastSynchronizedLivePtyIds &&
    earliestUnknownCapabilityRetryAtMs === Number.POSITIVE_INFINITY
  ) {
    return null
  }
  const nowMs = observedAtMs ?? Date.now()
  if (livePtyIds === lastSynchronizedLivePtyIds && nowMs < earliestUnknownCapabilityRetryAtMs) {
    return unknownCapabilityRetryDelayMs(nowMs)
  }
  const generation = ++synchronizationGeneration
  lastSynchronizedLivePtyIds = livePtyIds
  const live = new Set(livePtyIds.filter((id) => id.length > 0))
  let capabilityChanged = false
  for (const cachedId of authoritativeSnapshotByPtyId.keys()) {
    if (!live.has(cachedId)) {
      capabilityChanged ||= authoritativeSnapshotByPtyId.get(cachedId) === true
      authoritativeSnapshotByPtyId.delete(cachedId)
    }
  }
  for (const pendingId of unknownCapabilityRetryAtByPtyId.keys()) {
    if (!live.has(pendingId)) {
      unknownCapabilityRetryAtByPtyId.delete(pendingId)
      unknownCapabilityAttemptsByPtyId.delete(pendingId)
    }
  }

  const missing = [...live].filter(
    (id) =>
      !authoritativeSnapshotByPtyId.has(id) &&
      (unknownCapabilityRetryAtByPtyId.get(id) ?? 0) <= nowMs
  )
  const resolve = resolveCapabilities ?? window.api.pty.getAuthoritativeBufferSnapshotCapabilities
  if (!resolve) {
    for (const id of missing) {
      backOffUnknownCapability(id, nowMs)
    }
    refreshEarliestUnknownCapabilityRetry()
    if (capabilityChanged) {
      publishCapabilityChange()
    }
    return unknownCapabilityRetryDelayMs(nowMs)
  }
  for (let offset = 0; offset < missing.length; offset += 512) {
    const batch = missing.slice(offset, offset + 512)
    let resolved: SnapshotCapability[] | null
    try {
      resolved = await resolveSnapshotCapabilityBatch(resolve, batch)
    } catch {
      if (generation !== synchronizationGeneration) {
        // Why 0, not null: null ends a caller's timer chain, but the winning
        // pass may leave unknowns behind with nobody scheduled to re-ask (the
        // startup refresh ignores its return value). Re-checking immediately
        // is cheap — the early-outs above collapse it when nothing is pending.
        if (capabilityChanged) {
          publishCapabilityChange()
        }
        return 0
      }
      // Why: unknown capability must keep the pane mounted. Do not cache the
      // failure as supported; back off before retrying daemon startup.
      for (const id of batch) {
        backOffUnknownCapability(id, nowMs)
      }
      continue
    }
    if (generation !== synchronizationGeneration) {
      // Why 0: see the catch above — a superseded pass must keep its caller's
      // timer chain alive, or the 5-minute re-ask dies with it.
      if (capabilityChanged) {
        publishCapabilityChange()
      }
      return 0
    }
    if (!resolved) {
      for (const id of missing.slice(offset)) {
        backOffUnknownCapability(id, nowMs)
      }
      break
    }
    const resolvedById = new Map(resolved.map((entry) => [entry.id, entry.authoritative]))
    for (const id of batch) {
      const authoritative = resolvedById.get(id)
      if (typeof authoritative === 'boolean') {
        capabilityChanged ||=
          (authoritativeSnapshotByPtyId.get(id) === true) !== (authoritative === true)
        authoritativeSnapshotByPtyId.set(id, authoritative)
        unknownCapabilityRetryAtByPtyId.delete(id)
        unknownCapabilityAttemptsByPtyId.delete(id)
      } else {
        backOffUnknownCapability(id, nowMs)
      }
    }
  }
  refreshEarliestUnknownCapabilityRetry()
  if (capabilityChanged) {
    publishCapabilityChange()
  }
  return unknownCapabilityRetryDelayMs(observedAtMs === undefined ? Date.now() : nowMs)
}

export async function refreshTerminalProviderSnapshotCapabilities(
  livePtyIds: readonly string[],
  resolveCapabilities?: SnapshotCapabilityResolver
): Promise<number | null> {
  lastSynchronizedLivePtyIds = null
  let capabilityChanged = false
  for (const id of livePtyIds) {
    capabilityChanged ||= authoritativeSnapshotByPtyId.get(id) === true
    authoritativeSnapshotByPtyId.delete(id)
    unknownCapabilityRetryAtByPtyId.delete(id)
    unknownCapabilityAttemptsByPtyId.delete(id)
  }
  refreshEarliestUnknownCapabilityRetry()
  if (capabilityChanged) {
    publishCapabilityChange()
  }
  return synchronizeTerminalProviderSnapshotCapabilities(livePtyIds, resolveCapabilities)
}

export function startTerminalProviderSnapshotCapabilitySynchronization(
  livePtyIds: readonly string[]
): () => void {
  let disposed = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const synchronize = async (): Promise<void> => {
    const retryDelayMs = await synchronizeTerminalProviderSnapshotCapabilities(livePtyIds)
    if (!disposed && retryDelayMs !== null) {
      retryTimer = setTimeout(() => void synchronize(), Math.max(1, retryDelayMs))
    }
  }
  void synchronize()
  return () => {
    disposed = true
    clearTimeout(retryTimer)
  }
}

export function terminalProviderHasAuthoritativeSnapshot(ptyId: string): boolean {
  return authoritativeSnapshotByPtyId.get(ptyId) === true
}

export function clearTerminalProviderSnapshotCapabilities(): void {
  const capabilityChanged = [...authoritativeSnapshotByPtyId.values()].some(
    (authoritative) => authoritative
  )
  authoritativeSnapshotByPtyId.clear()
  unknownCapabilityRetryAtByPtyId.clear()
  unknownCapabilityAttemptsByPtyId.clear()
  lastSynchronizedLivePtyIds = null
  earliestUnknownCapabilityRetryAtMs = Number.POSITIVE_INFINITY
  synchronizationGeneration += 1
  if (capabilityChanged) {
    publishCapabilityChange()
  }
}
