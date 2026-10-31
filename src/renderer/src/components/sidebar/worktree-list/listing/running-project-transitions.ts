import type { SidebarCollapsibleGroup } from '@/store/slices/ui/ui-slice-contract-preferences'

export type RunningByGroupKey = ReadonlyMap<string, boolean>

export function toRunningByGroupKey(groups: readonly SidebarCollapsibleGroup[]): RunningByGroupKey {
  return new Map(groups.map((group) => [group.key, group.running]))
}

/** Projects that stopped or started running between two renders; newly shown headers are not transitions. */
export function getRunningProjectTransitions(
  previous: RunningByGroupKey,
  current: RunningByGroupKey
): { stopped: string[]; started: string[] } {
  const stopped: string[] = []
  const started: string[] = []
  for (const [key, running] of current) {
    const wasRunning = previous.get(key)
    if (wasRunning === undefined || wasRunning === running) {
      continue
    }
    ;(running ? started : stopped).push(key)
  }
  return { stopped, started }
}
