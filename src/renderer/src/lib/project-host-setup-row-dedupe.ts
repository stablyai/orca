import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import type {
  ProjectHostSetupSelection,
  ReadyProjectHostSetupOption
} from './project-host-setup-options'

/** Collapses ready setup rows to one per host, then one per checkout on a merged machine. */
export function dedupeReadySetupRows(
  options: readonly ReadyProjectHostSetupOption[],
  hostById: ReadonlyMap<ExecutionHostId, ExecutionHostRegistryEntry>
): ReadyProjectHostSetupOption[] {
  return collapseMergedHostCheckouts(options.filter(dedupeByHost()), hostById)
}

// Why: a project resolves to at most one setup per host — resolveWorkspaceCreationTarget takes the
// first project+host match and ignores the rest, so extra same-host setups are unreachable. Legacy
// profiles can still hold them (a linked worktree added as its own project projects a second local
// setup), which rendered as repeated identical "Local Mac" rows. Keep the first in input order so
// the row shown is the one workspace creation actually uses.
function dedupeByHost(): (option: ReadyProjectHostSetupOption) => boolean {
  const seenHosts = new Set<ExecutionHostId>()
  return (option) => {
    if (seenHosts.has(option.hostId)) {
      return false
    }
    seenHosts.add(option.hostId)
    return true
  }
}

// Why: an SSH host and its managed Orca server are one machine, and both can report the same
// checkout (the old SSH repo locally, the server's own setup remotely), which rendered as two
// identical rows. Keep the one on the row the picker shows, the route serving the host now. A
// different path on the other id is a distinct checkout, so it keeps its own row.
function collapseMergedHostCheckouts(
  options: readonly ReadyProjectHostSetupOption[],
  hostById: ReadonlyMap<ExecutionHostId, ExecutionHostRegistryEntry>
): ReadyProjectHostSetupOption[] {
  const findShown = (option: ReadyProjectHostSetupOption): ReadyProjectHostSetupOption | null => {
    const mergedIntoHostId = hostById.get(option.hostId)?.mergedIntoHostId
    return mergedIntoHostId
      ? (options.find((other) => other.hostId === mergedIntoHostId && other.path === option.path) ??
          null)
      : null
  }
  const aliasesByShown = new Map<ReadyProjectHostSetupOption, ProjectHostSetupSelection[]>()
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
