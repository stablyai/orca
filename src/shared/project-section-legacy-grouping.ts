import type { GroupingSetup } from './project-grouping'
import { getProjectCheckoutPathKey, getProjectHostNamespace } from './project-grouping'

/** Older desktops publish no resolved keys; reproduce their display until they update. */
export function withLegacyProjectGroupKeys<S extends GroupingSetup>(
  setups: readonly S[]
): (S & { groupKey: string })[] {
  const pathsBySurface = new Map<string, Set<string>>()
  for (const setup of setups) {
    if (setup.setupMethod === 'provisioned' || setup.kind === 'folder') {
      continue
    }
    const surface = `${setup.projectId}::${getProjectHostNamespace(setup)}`
    const paths = pathsBySurface.get(surface) ?? new Set<string>()
    paths.add(getProjectCheckoutPathKey(setup))
    pathsBySurface.set(surface, paths)
  }
  return setups.map((setup) => {
    if (setup.groupKey) {
      return { ...setup, groupKey: setup.groupKey }
    }
    const separate =
      setup.setupMethod !== 'provisioned' &&
      setup.kind !== 'folder' &&
      (pathsBySurface.get(`${setup.projectId}::${getProjectHostNamespace(setup)}`)?.size ?? 0) > 1
    return {
      ...setup,
      groupKey: `project:${setup.projectId}${separate ? `::setup:${setup.repoId}` : ''}`
    }
  })
}
