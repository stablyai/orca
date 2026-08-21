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

/** Sum of memory across ports; `null` when no port has a sample. Dedupes by pid —
 *  a process bound to multiple ports reports the same process-level memory on each row. */
function sumMemory(ports: readonly { pid?: number; memory?: number }[]): number | null {
  let sum = 0
  let hasValue = false
  const seenPids = new Set<number>()
  for (const port of ports) {
    if (port.pid != null) {
      if (seenPids.has(port.pid)) {
        continue
      }
      seenPids.add(port.pid)
    }
    if (port.memory != null) {
      sum += port.memory
      hasValue = true
    }
  }
  return hasValue ? sum : null
}

/** Records one sample per workspace group plus one for the external-ports bucket. */
export function recordWorkspacePortMemorySamples(
  groups: readonly WorkspacePortGroup[],
  externalPorts: readonly { pid?: number; memory?: number }[]
): void {
  const now = Date.now()
  // Why: sweep before pushing — otherwise a group untouched for 10+ minutes
  // (e.g. the popover was closed) gets its touchedAt revived by the push
  // below before staleness is ever checked, and its old samples survive to
  // render as a misleading gap-free sparkline.
  sweepStale(now)
  for (const group of groups) {
    const memory = sumMemory(group.ports)
    if (memory != null) {
      pushSample(group.worktreeId, memory, now)
    }
  }
  if (externalPorts.length > 0) {
    const memory = sumMemory(externalPorts)
    if (memory != null) {
      pushSample(EXTERNAL_PORTS_HISTORY_KEY, memory, now)
    }
  }
}

export function readWorkspacePortMemoryHistory(key: string): number[] {
  const ring = historyByKey.get(key)
  return ring ? [...ring.samples] : []
}

/** Test-only: clears all recorded history so tests don't leak state across runs. */
export function resetWorkspacePortMemoryHistoryForTests(): void {
  historyByKey.clear()
}
