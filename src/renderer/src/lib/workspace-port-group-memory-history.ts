import type { WorkspacePortGroup } from './workspace-port-groups'

/**
 * Client-side memory-history ring for the Ports popover's sparkline — same
 * shape and constants as the Resource Manager's main-process ring
 * (src/main/memory/collector.ts), just kept in the renderer since port
 * groups are already assembled here rather than over IPC.
 */

const HISTORY_CAPACITY = 60
const HISTORY_STALE_MS = 10 * 60 * 1000
export const EXTERNAL_PORTS_HISTORY_KEY = '__external__'

type HistoryRing = {
  samples: number[]
  touchedAt: number
}

const historyByKey = new Map<string, HistoryRing>()

function pushSample(key: string, memoryBytes: number, now: number): void {
  let ring = historyByKey.get(key)
  if (!ring) {
    ring = { samples: [], touchedAt: now }
    historyByKey.set(key, ring)
  }
  ring.samples.push(memoryBytes)
  if (ring.samples.length > HISTORY_CAPACITY) {
    ring.samples.shift()
  }
  ring.touchedAt = now
}

function sweepStale(now: number): void {
  for (const [key, ring] of historyByKey) {
    if (now - ring.touchedAt > HISTORY_STALE_MS) {
      historyByKey.delete(key)
    }
  }
}

function sumMemory(ports: readonly { memory?: number }[]): number {
  let sum = 0
  for (const port of ports) {
    sum += port.memory ?? 0
  }
  return sum
}

/** Records one sample per workspace group plus one for the external-ports bucket. */
export function recordWorkspacePortMemorySamples(
  groups: readonly WorkspacePortGroup[],
  externalPorts: readonly { memory?: number }[]
): void {
  const now = Date.now()
  for (const group of groups) {
    pushSample(group.worktreeId, sumMemory(group.ports), now)
  }
  if (externalPorts.length > 0) {
    pushSample(EXTERNAL_PORTS_HISTORY_KEY, sumMemory(externalPorts), now)
  }
  sweepStale(now)
}

export function readWorkspacePortMemoryHistory(key: string): number[] {
  const ring = historyByKey.get(key)
  return ring ? [...ring.samples] : []
}

/** Test-only: clears all recorded history so tests don't leak state across runs. */
export function resetWorkspacePortMemoryHistoryForTests(): void {
  historyByKey.clear()
}
