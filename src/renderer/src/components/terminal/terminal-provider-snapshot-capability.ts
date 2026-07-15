type SnapshotCapability = { id: string; authoritative: boolean | null }

const authoritativeSnapshotByPtyId = new Map<string, boolean>()
const unknownCapabilityRetryAtByPtyId = new Map<string, number>()
const UNKNOWN_CAPABILITY_RETRY_MS = 1_000

export function synchronizeTerminalProviderSnapshotCapabilities(
  livePtyIds: readonly string[],
  resolveCapabilities?: (ids: string[]) => SnapshotCapability[],
  nowMs = Date.now()
): void {
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
}

export function terminalProviderHasAuthoritativeSnapshot(ptyId: string): boolean {
  return authoritativeSnapshotByPtyId.get(ptyId) === true
}

export function clearTerminalProviderSnapshotCapabilities(): void {
  authoritativeSnapshotByPtyId.clear()
  unknownCapabilityRetryAtByPtyId.clear()
}
