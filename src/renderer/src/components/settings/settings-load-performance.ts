import type { GlobalSettings } from '../../../../shared/types'

const EAGER_SECTION_IDS = new Set(['general'])

export function getRuntimeTargetIdentity(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): string {
  return settings?.activeRuntimeEnvironmentId?.trim() || 'local'
}

export function deriveNeededSectionIds(args: {
  navSectionIds: string[]
  mountedSectionIds: Set<string>
  activeSectionId: string | null
  pendingSectionId: string | null
  query: string
  visibleSectionIds: Set<string>
}): Set<string> {
  const next = new Set(args.mountedSectionIds)
  for (const sectionId of args.navSectionIds) {
    if (EAGER_SECTION_IDS.has(sectionId)) {
      next.add(sectionId)
    }
  }
  if (args.activeSectionId) {
    next.add(args.activeSectionId)
  }
  if (args.pendingSectionId) {
    next.add(args.pendingSectionId)
  }
  if (args.query.trim() !== '') {
    for (const visibleSectionId of args.visibleSectionIds) {
      next.add(visibleSectionId)
    }
  }
  return next
}

export function deriveNeededRepoIds(
  repos: readonly { id: string }[],
  neededSectionIds: Set<string>
): string[] {
  return repos.map((repo) => repo.id).filter((repoId) => neededSectionIds.has(`repo-${repoId}`))
}

export function getInitialMountedSectionIds(): Set<string> {
  return new Set(EAGER_SECTION_IDS)
}
