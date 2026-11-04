import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import type {
  ProjectHostSetupSelection,
  ReadyProjectHostSetupOption
} from './project-host-setup-options'

export type SelectedProjectHostSetup = { projectHostSetupId: string; hostId: ExecutionHostId }

/** Collapses ready setup rows to one per host, then one per checkout on a merged machine. */
export function dedupeReadySetupRows(
  options: readonly ReadyProjectHostSetupOption[],
  hostById: ReadonlyMap<ExecutionHostId, ExecutionHostRegistryEntry>,
  selected?: SelectedProjectHostSetup | null
): ReadyProjectHostSetupOption[] {
  return collapseMergedHostCheckouts(
    selectedFirst(options, selected).filter(dedupeByHost()),
    hostById
  )
}

// Per-host dedupe keeps the first row, so a host with several checkouts shows the selected one.
function selectedFirst(
  options: readonly ReadyProjectHostSetupOption[],
  selected: SelectedProjectHostSetup | null | undefined
): readonly ReadyProjectHostSetupOption[] {
  const isSelected = (option: ReadyProjectHostSetupOption): boolean =>
    option.id === selected?.projectHostSetupId && option.hostId === selected.hostId
  return selected
    ? [...options.filter(isSelected), ...options.filter((option) => !isSelected(option))]
    : options
}

// One row per host; the project picker lists a host's other checkouts, so Run on only switches host.
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

// SSH and managed server may report the same machine/checkout; keep the picker’s current route. Distinct paths remain separate checkouts.
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
