import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import { isMultiRepoSelectionFull } from './multi-repo-composer-model'
import {
  listProjectEligibleHostIds,
  resolveProjectSetupForHost,
  type ProjectSetupIneligibleReason
} from './resolve-project-setup-for-host'

type ProjectOption = Extract<NewWorkspaceProjectOption, { kind: 'project' }>

export type MultiProjectPickerRow = {
  option: ProjectOption
  selected: boolean
  /** Set when the row cannot be added; selected rows stay toggleable so they can be removed. */
  unavailable: ProjectSetupIneligibleReason | 'limit_reached' | null
  /** The one other host where this project has an eligible setup, for "Use <other host>". */
  alternativeHostId: ExecutionHostId | null
}

export type MultiProjectPickerRows = {
  available: MultiProjectPickerRow[]
  unavailable: MultiProjectPickerRow[]
}

/** Eligible rows first in the given order, unavailable ones after the divider. */
export function buildMultiProjectPickerRows(
  options: readonly NewWorkspaceProjectOption[],
  setups: readonly ProjectHostSetup[],
  hostId: ExecutionHostId,
  selectedProjectIds: readonly string[]
): MultiProjectPickerRows {
  const rows: MultiProjectPickerRows = { available: [], unavailable: [] }
  const full = isMultiRepoSelectionFull(selectedProjectIds)
  for (const option of options) {
    if (option.kind !== 'project') {
      continue
    }
    const selected = selectedProjectIds.includes(option.projectId)
    const resolution = resolveProjectSetupForHost(option.projectId, hostId, setups)
    const unavailable =
      resolution.status === 'unavailable'
        ? resolution.reason
        : full && !selected
          ? 'limit_reached'
          : null
    const otherHosts =
      resolution.status === 'unavailable'
        ? listProjectEligibleHostIds(option.projectId, setups).filter((id) => id !== hostId)
        : []
    const row: MultiProjectPickerRow = {
      option,
      selected,
      unavailable,
      alternativeHostId: otherHosts.length === 1 ? otherHosts[0] : null
    }
    // A selected project without a setup stays in the list so the user can see and deselect it.
    ;(unavailable && !selected ? rows.unavailable : rows.available).push(row)
  }
  return rows
}
