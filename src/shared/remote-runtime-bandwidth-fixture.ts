import { createHash } from 'node:crypto'
import type { RuntimeMobileSessionTabsResult } from './runtime-types'

// Synthetic session-tabs metadata; no captured user paths, titles, or terminal contents.
export function bandwidthSnapshot(version: number, terminalCount = 17) {
  const uuid = (seed: number): string => {
    const hex = createHash('sha256').update(`terminal-${seed}`).digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  const tabs = Array.from({ length: terminalCount }, (_, index) => {
    const id = uuid(index)
    const leaf = uuid(index + 100)
    return {
      type: 'terminal' as const,
      id: `${id}::${leaf}`,
      parentTabId: id,
      leafId: leaf,
      title: `Agent ${index}: reviewing remote subscription ${version % 7}`,
      status: 'ready' as const,
      terminal: `term_${uuid(index + 200)}`,
      isActive: index === 0,
      launchAgent: index % 2 ? ('claude' as const) : ('codex' as const),
      startupCwd: `/workspace/project-${index}/packages/runtime`,
      ptyId: uuid(index + 300),
      incarnationId: uuid(index + 400),
      agentStatus: {
        state: index % 3 ? ('waiting' as const) : ('working' as const),
        prompt: `Review task ${index} for module ${id.slice(0, 8)}`,
        paneKey: `${id}:${leaf}`,
        updatedAt: 1_000 + version,
        stateStartedAt: 1_000,
        stateHistory: []
      }
    }
  })
  return {
    type: 'updated',
    worktree: '/workspace/fixture-folder',
    publicationEpoch: uuid(1000),
    snapshotVersion: version,
    activeGroupId: uuid(1001),
    activeTabId: tabs[0]!.id,
    activeTabType: 'terminal',
    tabGroups: [{ id: uuid(1001), activeTabId: tabs[0]!.id, tabOrder: tabs.map((tab) => tab.id) }],
    tabs
  } satisfies RuntimeMobileSessionTabsResult & { type: 'updated' }
}

export function bandwidthResponse(version: number, terminalCount = 17): string {
  return JSON.stringify({
    id: 'subscription',
    ok: true,
    streaming: true,
    result: bandwidthSnapshot(version, terminalCount),
    _meta: { runtimeId: 'bandwidth-fixture' }
  })
}

// FIFO serialization at 0.8 Mbps, with 37 ms propagation in each direction.
// This deliberately excludes TCP loss, kernel buffering, and application execution time.
export class ConstrainedRuntimeLink {
  private availableAt = 0
  bytes = 0
  peakQueuedBytes = 0
  readonly interactiveLatencies: number[] = []

  send(at: number, payload: string | Uint8Array, interactive = false): void {
    const payloadBytes =
      typeof payload === 'string' ? Buffer.byteLength(payload) : payload.byteLength
    const frameBytes = payloadBytes + (payloadBytes < 126 ? 2 : payloadBytes <= 65_535 ? 4 : 10)
    this.bytes += frameBytes
    const arrival = at + (interactive ? 37 : 0)
    this.availableAt = Math.max(arrival, this.availableAt) + frameBytes / 100
    this.peakQueuedBytes = Math.max(this.peakQueuedBytes, (this.availableAt - arrival) * 100)
    if (interactive) {
      this.interactiveLatencies.push(this.availableAt + 37 - at)
    }
  }

  metrics() {
    const sorted = [...this.interactiveLatencies].sort((a, b) => a - b)
    return {
      wireBytes: this.bytes,
      peakQueuedBytes: Math.ceil(this.peakQueuedBytes),
      rpcP95Ms: Math.ceil(sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0),
      rpcMaxMs: Math.ceil(sorted.at(-1) ?? 0),
      drainAtMs: Math.ceil(this.availableAt)
    }
  }
}
