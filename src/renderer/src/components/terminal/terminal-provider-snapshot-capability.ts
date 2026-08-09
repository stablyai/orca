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
const capabilityRevisionListeners = new Set<() => void>()
const unknownCapabilityRetryAtByPtyId = new Map<string, number>()
const unknownCapabilityAttemptsByPtyId = new Map<string, number>()
const UNKNOWN_CAPABILITY_RETRY_MS = 1_000
const UNKNOWN_CAPABILITY_MAX_RETRY_MS = 30_000
/** 1/2/4/8/16/30/30 s — ~91 s of daemon-startup grace, then settle conservatively. */
const UNKNOWN_CAPABILITY_MAX_ATTEMPTS = 8
const CAPABILITY_RESOLUTION_TIMEOUT_MS = 1_000
let lastSynchronizedLivePtyIds: readonly string[] | null = null
let earliestUnknownCapabilityRetryAtMs = Number.POSITIVE_INFINITY
let synchronizationGeneration = 0
let terminalProviderSnapshotCapabilityRevision = 0

export type TerminalProviderSnapshotCapabilityState = 'pending' | 'authoritative' | 'unavailable'

function publishTerminalProviderSnapshotCapabilityChange(changed: boolean): void {
  if (!changed) {
    return
  }
  terminalProviderSnapshotCapabilityRevision += 1
  for (const listener of capabilityRevisionListeners) {
    listener()
  }
}

function setTerminalProviderSnapshotCapability(ptyId: string, authoritative: boolean): boolean {
  if (
    authoritativeSnapshotByPtyId.has(ptyId) &&
    authoritativeSnapshotByPtyId.get(ptyId) === authoritative
  ) {
    return false
  }
  authoritativeSnapshotByPtyId.set(ptyId, authoritative)
  return true
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

// Unknown routes settle eager after bounded retries to avoid lifelong capability polling.
function backOffUnknownCapability(ptyId: string, nowMs: number): boolean {
  const attempts = (unknownCapabilityAttemptsByPtyId.get(ptyId) ?? 0) + 1
  if (attempts >= UNKNOWN_CAPABILITY_MAX_ATTEMPTS) {
    const changed = setTerminalProviderSnapshotCapability(ptyId, false)
    unknownCapabilityAttemptsByPtyId.delete(ptyId)
    unknownCapabilityRetryAtByPtyId.delete(ptyId)
    return changed
  }
  unknownCapabilityAttemptsByPtyId.set(ptyId, attempts)
  unknownCapabilityRetryAtByPtyId.set(
    ptyId,
    nowMs +
      Math.min(UNKNOWN_CAPABILITY_RETRY_MS * 2 ** (attempts - 1), UNKNOWN_CAPABILITY_MAX_RETRY_MS)
  )
  return false
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
      capabilityChanged = authoritativeSnapshotByPtyId.delete(cachedId) || capabilityChanged
    }
  }
  for (const pendingId of unknownCapabilityRetryAtByPtyId.keys()) {
    if (!live.has(pendingId)) {
      unknownCapabilityRetryAtByPtyId.delete(pendingId)
      unknownCapabilityAttemptsByPtyId.delete(pendingId)
    }
  }
  publishTerminalProviderSnapshotCapabilityChange(capabilityChanged)
  capabilityChanged = false

  const missing = [...live].filter(
    (id) =>
      !authoritativeSnapshotByPtyId.has(id) &&
      (unknownCapabilityRetryAtByPtyId.get(id) ?? 0) <= nowMs
  )
  const resolve = resolveCapabilities ?? window.api.pty.getAuthoritativeBufferSnapshotCapabilities
  if (!resolve) {
    for (const id of missing) {
      capabilityChanged = backOffUnknownCapability(id, nowMs) || capabilityChanged
    }
    refreshEarliestUnknownCapabilityRetry()
    publishTerminalProviderSnapshotCapabilityChange(capabilityChanged)
    return unknownCapabilityRetryDelayMs(nowMs)
  }
  for (let offset = 0; offset < missing.length; offset += 512) {
    const batch = missing.slice(offset, offset + 512)
    let resolved: SnapshotCapability[] | null
    try {
      resolved = await resolveSnapshotCapabilityBatch(resolve, batch)
    } catch {
      if (generation !== synchronizationGeneration) {
        return null
      }
      // Why: unknown capability must keep the pane mounted. Do not cache the
      // failure as supported; back off before retrying daemon startup.
      for (const id of batch) {
        capabilityChanged = backOffUnknownCapability(id, nowMs) || capabilityChanged
      }
      continue
    }
    if (generation !== synchronizationGeneration) {
      return null
    }
    if (!resolved) {
      for (const id of missing.slice(offset)) {
        capabilityChanged = backOffUnknownCapability(id, nowMs) || capabilityChanged
      }
      break
    }
    const resolvedById = new Map(resolved.map((entry) => [entry.id, entry.authoritative]))
    for (const id of batch) {
      const authoritative = resolvedById.get(id)
      if (typeof authoritative === 'boolean') {
        capabilityChanged =
          setTerminalProviderSnapshotCapability(id, authoritative) || capabilityChanged
        unknownCapabilityRetryAtByPtyId.delete(id)
        unknownCapabilityAttemptsByPtyId.delete(id)
      } else {
        capabilityChanged = backOffUnknownCapability(id, nowMs) || capabilityChanged
      }
    }
  }
  refreshEarliestUnknownCapabilityRetry()
  publishTerminalProviderSnapshotCapabilityChange(capabilityChanged)
  return unknownCapabilityRetryDelayMs(observedAtMs === undefined ? Date.now() : nowMs)
}

export async function refreshTerminalProviderSnapshotCapabilities(
  livePtyIds: readonly string[],
  resolveCapabilities?: SnapshotCapabilityResolver
): Promise<number | null> {
  lastSynchronizedLivePtyIds = null
  let capabilityChanged = false
  for (const id of livePtyIds) {
    capabilityChanged = authoritativeSnapshotByPtyId.delete(id) || capabilityChanged
    unknownCapabilityRetryAtByPtyId.delete(id)
    unknownCapabilityAttemptsByPtyId.delete(id)
  }
  refreshEarliestUnknownCapabilityRetry()
  publishTerminalProviderSnapshotCapabilityChange(capabilityChanged)
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

export function getTerminalProviderSnapshotCapabilityState(
  ptyId: string
): TerminalProviderSnapshotCapabilityState {
  const authoritative = authoritativeSnapshotByPtyId.get(ptyId)
  return authoritative === undefined ? 'pending' : authoritative ? 'authoritative' : 'unavailable'
}

export function getTerminalProviderSnapshotCapabilityRevision(): number {
  return terminalProviderSnapshotCapabilityRevision
}

export function subscribeTerminalProviderSnapshotCapabilityRevision(
  listener: () => void
): () => void {
  capabilityRevisionListeners.add(listener)
  return () => capabilityRevisionListeners.delete(listener)
}

export function clearTerminalProviderSnapshotCapabilities(): void {
  const capabilityChanged = authoritativeSnapshotByPtyId.size > 0
  authoritativeSnapshotByPtyId.clear()
  unknownCapabilityRetryAtByPtyId.clear()
  unknownCapabilityAttemptsByPtyId.clear()
  lastSynchronizedLivePtyIds = null
  earliestUnknownCapabilityRetryAtMs = Number.POSITIVE_INFINITY
  synchronizationGeneration += 1
  publishTerminalProviderSnapshotCapabilityChange(capabilityChanged)
}
