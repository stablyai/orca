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
  const hasSearchQuery = args.query.trim() !== ''
  const next = hasSearchQuery ? new Set<string>() : new Set(args.mountedSectionIds)
  if (!hasSearchQuery) {
    for (const sectionId of args.navSectionIds) {
      if (EAGER_SECTION_IDS.has(sectionId)) {
        next.add(sectionId)
      }
    }
  }
  if (
    args.activeSectionId &&
    (!hasSearchQuery || args.visibleSectionIds.has(args.activeSectionId))
  ) {
    next.add(args.activeSectionId)
  }
  if (args.pendingSectionId) {
    next.add(args.pendingSectionId)
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
