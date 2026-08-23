export const REPO_MANAGED_DERIVE_PHASES = ['preparing', 'init', 'seed', 'sync', 'register'] as const

export type RepoManagedDerivePhase = (typeof REPO_MANAGED_DERIVE_PHASES)[number]

export type RepoManagedDeriveProgress = {
  phase: RepoManagedDerivePhase
  step: number
  total: number
  percent: number
}

export function repoManagedDeriveProgress(
  phase: RepoManagedDerivePhase
): RepoManagedDeriveProgress {
  const index = REPO_MANAGED_DERIVE_PHASES.indexOf(phase)
  const step = index !== -1 ? index + 1 : 1
  const total = REPO_MANAGED_DERIVE_PHASES.length
  return {
    phase,
    step,
    total,
    percent: Math.round((step / total) * 100)
  }
}
