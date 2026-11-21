import type { UnifiedProjectGroup } from './resource-usage-merge-types'

/** Only sampled rows contribute to a project's totals; unsampled-only projects stay null. */
export function applyProjectTotals(repo: UnifiedProjectGroup): void {
  let cpuSum = 0
  let memSum = 0
  let anyLocal = false
  for (const wt of repo.worktrees) {
    if (wt.cpu !== null && wt.memory !== null) {
      cpuSum += wt.cpu
      memSum += wt.memory
      anyLocal = true
    }
  }
  repo.cpu = anyLocal ? cpuSum : null
  repo.memory = anyLocal ? memSum : null
}
