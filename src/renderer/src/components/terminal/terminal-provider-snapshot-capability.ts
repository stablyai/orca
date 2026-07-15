type SnapshotCapability = { id: string; authoritative: boolean | null }

const authoritativeSnapshotByPtyId = new Map<string, boolean>()
const unknownCapabilityRetryAtByPtyId = new Map<string, number>()
const UNKNOWN_CAPABILITY_RETRY_MS = 1_000
let lastSynchronizedLivePtyIds: readonly string[] | null = null
let earliestUnknownCapabilityRetryAtMs = Number.POSITIVE_INFINITY

function refreshEarliestUnknownCapabilityRetry(): void {
  earliestUnknownCapabilityRetryAtMs = Number.POSITIVE_INFINITY
  for (const retryAtMs of unknownCapabilityRetryAtByPtyId.values()) {
    earliestUnknownCapabilityRetryAtMs = Math.min(earliestUnknownCapabilityRetryAtMs, retryAtMs)
  }
}

export function synchronizeTerminalProviderSnapshotCapabilities(
  livePtyIds: readonly string[],
  resolveCapabilities?: (ids: string[]) => SnapshotCapability[],
  observedAtMs?: number
): void {
  // Why: Terminal can re-render for unrelated UI state. A stable binding list
  // must add no repeated all-PTY scan or IPC work to that render path.
  if (
    livePtyIds === lastSynchronizedLivePtyIds &&
    earliestUnknownCapabilityRetryAtMs === Number.POSITIVE_INFINITY
  ) {
    return
  }
  const nowMs = observedAtMs ?? Date.now()
  if (livePtyIds === lastSynchronizedLivePtyIds && nowMs < earliestUnknownCapabilityRetryAtMs) {
    return
  }
  lastSynchronizedLivePtyIds = livePtyIds
  const live = new Set(livePtyIds.filter((id) => id.length > 0))
  for (const cachedId of authoritativeSnapshotByPtyId.keys()) {
    if (!live.has(cachedId)) {
      authoritativeSnapshotByPtyId.delete(cachedId)
    }
  }
  for (const pendingId of unknownCapabilityRetryAtByPtyId.keys()) {
    if (!live.has(pendingId)) {
      unknownCapabilityRetryAtByPtyId.delete(pendingId)
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
      unknownCapabilityRetryAtByPtyId.set(id, nowMs + UNKNOWN_CAPABILITY_RETRY_MS)
    }
    refreshEarliestUnknownCapabilityRetry()
    return
  }
  for (let offset = 0; offset < missing.length; offset += 512) {
    const batch = missing.slice(offset, offset + 512)
    let resolved: SnapshotCapability[]
    try {
      resolved = resolve(batch)
    } catch {
      // Why: unknown capability must keep the pane mounted. Do not cache the
      // failure as supported; back off before retrying daemon startup.
      for (const id of batch) {
        unknownCapabilityRetryAtByPtyId.set(id, nowMs + UNKNOWN_CAPABILITY_RETRY_MS)
      }
      continue
    }
    const resolvedById = new Map(resolved.map((entry) => [entry.id, entry.authoritative]))
    for (const id of batch) {
      const authoritative = resolvedById.get(id)
      if (typeof authoritative === 'boolean') {
        authoritativeSnapshotByPtyId.set(id, authoritative)
        unknownCapabilityRetryAtByPtyId.delete(id)
      } else {
        unknownCapabilityRetryAtByPtyId.set(id, nowMs + UNKNOWN_CAPABILITY_RETRY_MS)
      }
    }
  }
  refreshEarliestUnknownCapabilityRetry()
}

export function terminalProviderHasAuthoritativeSnapshot(ptyId: string): boolean {
  return authoritativeSnapshotByPtyId.get(ptyId) === true
}

export function clearTerminalProviderSnapshotCapabilities(): void {
  authoritativeSnapshotByPtyId.clear()
  unknownCapabilityRetryAtByPtyId.clear()
  lastSynchronizedLivePtyIds = null
  earliestUnknownCapabilityRetryAtMs = Number.POSITIVE_INFINITY
}
