import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import type { ProjectHostSetupSelection } from './project-host-setup-options'

type ProjectHostCheckoutRow = ProjectHostSetupSelection & { path: string }

/** Collapses equivalent checkout routes on a merged machine. */
export function dedupeReadySetupRows<T extends ProjectHostCheckoutRow>(
  options: readonly T[],
  hostById: ReadonlyMap<ExecutionHostId, ExecutionHostRegistryEntry>
): T[] {
  return collapseMergedHostCheckouts(options, hostById)
}

// SSH and its managed server can report one checkout through two routes.
function collapseMergedHostCheckouts<T extends ProjectHostCheckoutRow>(
  options: readonly T[],
  hostById: ReadonlyMap<ExecutionHostId, ExecutionHostRegistryEntry>
): T[] {
  const findShown = (option: T): T | null => {
    const mergedIntoHostId = hostById.get(option.hostId)?.mergedIntoHostId
    return mergedIntoHostId
      ? (options.find((other) => other.hostId === mergedIntoHostId && other.path === option.path) ??
          null)
      : null
  }
  const aliasesByShown = new Map<T, ProjectHostSetupSelection[]>()
  for (const option of options) {
    const shown = findShown(option)
    if (shown) {
      const aliases = aliasesByShown.get(shown) ?? []
      aliases.push({ id: option.id, hostId: option.hostId })
      aliasesByShown.set(shown, aliases)
    }
  }
  return options
    .filter((option) => !findShown(option))
    .map((option) => {
      const aliasSetups = aliasesByShown.get(option)
      return aliasSetups ? { ...option, aliasSetups } : option
    })
}
