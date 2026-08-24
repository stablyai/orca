export const REPO_MANAGED_DERIVE_PHASES = ['preparing', 'init', 'seed', 'sync', 'register'] as const

export type RepoManagedDerivePhase = (typeof REPO_MANAGED_DERIVE_PHASES)[number]

export type RepoManagedDeriveProgress = {
  phase: RepoManagedDerivePhase
  step: number
  total: number
  percent: number
  currentProject?: string
  processedProjects?: number
  totalProjects?: number
}

export function repoManagedDeriveProgress(
  phase: RepoManagedDerivePhase,
  details?: Pick<
    RepoManagedDeriveProgress,
    'currentProject' | 'processedProjects' | 'totalProjects'
  >
): RepoManagedDeriveProgress {
  const index = REPO_MANAGED_DERIVE_PHASES.indexOf(phase)
  const step = index !== -1 ? index + 1 : 1
  const total = REPO_MANAGED_DERIVE_PHASES.length
  const seedFraction =
    phase === 'seed' && details?.totalProjects
      ? Math.min(1, (details.processedProjects ?? 0) / details.totalProjects)
      : 1
  return {
    phase,
    step,
    total,
    percent: Math.round(((step - 1 + seedFraction) / total) * 100),
    ...details
  }
}
