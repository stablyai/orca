import { parseWorkspaceKey } from './workspace-scope'
import type { MaestroRunProgress } from './maestro-run-progress'

export type MaestroCanvasIndexEntry = {
  executionHostId: string
  workspaceKey: string
  revision: number
  updatedAt: string
  intentCounts: { pending: number; claimed: number; settled: number }
  runProgress?: MaestroRunProgress
}

export function buildMaestroCanvasIndex(
  entries: readonly MaestroCanvasIndexEntry[]
): MaestroCanvasIndexEntry[] {
  const deduplicated = new Map<string, MaestroCanvasIndexEntry>()
  for (const entry of entries) {
    if (!parseWorkspaceKey(entry.workspaceKey)) {
      continue
    }
    const key = `${entry.executionHostId}\u0000${entry.workspaceKey}`
    const current = deduplicated.get(key)
    if (!current || current.updatedAt < entry.updatedAt) {
      deduplicated.set(key, entry)
    }
  }
  return [...deduplicated.values()].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
  )
}
