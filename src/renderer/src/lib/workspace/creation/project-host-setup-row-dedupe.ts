import type { ExecutionHostRegistryEntry } from '../../../../../shared/execution-host/execution-host-registry-entry'
import { getProjectCheckoutPathKey } from '../../../../../shared/project-grouping'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../../shared/execution-host'
import type {
  ProjectHostSetupOption,
  ProjectHostSetupSelection,
  ReadyProjectHostSetupOption
} from './project-host-setup-options'

export type SelectedProjectHostSetup = { projectHostSetupId: string; hostId: ExecutionHostId }

/** Collapses equivalent checkout registrations, including aliases of a merged machine. */
export function dedupeReadySetupRows(
  options: readonly ReadyProjectHostSetupOption[],
  hostById: ReadonlyMap<ExecutionHostId, ExecutionHostRegistryEntry>,
  selected?: SelectedProjectHostSetup | null
): ReadyProjectHostSetupOption[] {
  return collapseMergedHostCheckouts(
    selectedFirst(options, selected).filter(dedupeByCheckout()),
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

function dedupeByCheckout(): (option: ReadyProjectHostSetupOption) => boolean {
  const seen = new Set<string>()
  return (option) => {
    const key = getProjectCheckoutPathKey({
      ...option,
      displayName: option.detail,
      setupMethod: 'legacy-repo',
      kind: undefined
    })
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  }
}

// SSH and managed server may report the same machine/checkout; keep the picker’s current route. Distinct paths remain separate checkouts.
function collapseMergedHostCheckouts(
  options: readonly ReadyProjectHostSetupOption[],
  hostById: ReadonlyMap<ExecutionHostId, ExecutionHostRegistryEntry>
): ReadyProjectHostSetupOption[] {
  const firstByHostPath = new Map<ExecutionHostId, Map<string, ReadyProjectHostSetupOption>>()
  for (const option of options) {
    let paths = firstByHostPath.get(option.hostId)
    if (!paths) {
      paths = new Map()
      firstByHostPath.set(option.hostId, paths)
    }
    if (!paths.has(option.path)) {
      paths.set(option.path, option)
    }
  }
  const findShown = (option: ReadyProjectHostSetupOption): ReadyProjectHostSetupOption | null => {
    const mergedIntoHostId = hostById.get(option.hostId)?.mergedIntoHostId
    return mergedIntoHostId
      ? (firstByHostPath.get(mergedIntoHostId)?.get(option.path) ?? null)
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

export function compareProjectHostSetupOptions(
  a: ProjectHostSetupOption,
  b: ProjectHostSetupOption
): number {
  if (a.hostId === LOCAL_EXECUTION_HOST_ID && b.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return -1
  }
  if (b.hostId === LOCAL_EXECUTION_HOST_ID && a.hostId !== LOCAL_EXECUTION_HOST_ID) {
    return 1
  }
  const aDetail = a.kind === 'ready' ? a.path : a.detail
  const bDetail = b.kind === 'ready' ? b.path : b.detail
  return a.label.localeCompare(b.label) || aDetail.localeCompare(bDetail)
}
