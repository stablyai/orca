import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'

/**
 * Mirror-shaped snapshot of the fields the debounced persisted-UI writer owns.
 *
 * Why (STA-5781): the shared PersistedUIState is edited concurrently by desktop,
 * web, and mobile clients. Whole-snapshot writes let a stale mirror overwrite
 * another client's disjoint fields, so hydration captures this baseline and the
 * writer persists only the fields this client actually changed since then.
 */
export type PersistedUIWriteBaseline = {
  sidebarWidth: number
  rightSidebarOpen: boolean
  rightSidebarTab: PersistedUIState['rightSidebarTab']
  rightSidebarExplorerView: PersistedUIState['rightSidebarExplorerView']
  rightSidebarWidth: number
  markdownTocPanelWidth: number
  combinedDiffFileTreeWidth: number
  groupBy: PersistedUIState['groupBy']
  sortBy: PersistedUIState['sortBy']
  projectOrderBy: PersistedUIState['projectOrderBy']
  showSleepingWorkspaces: boolean
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  alwaysShowDefaultBranchWorkspace: boolean
  showDotfilesByWorktree: Record<string, boolean>
  filterRepoIds: readonly string[]
  acknowledgedAgentsByPaneKey: Record<string, number>
}

export const PERSISTED_UI_WRITE_BASELINE_FIELDS = [
  'sidebarWidth',
  'rightSidebarOpen',
  'rightSidebarTab',
  'rightSidebarExplorerView',
  'rightSidebarWidth',
  'markdownTocPanelWidth',
  'combinedDiffFileTreeWidth',
  'groupBy',
  'sortBy',
  'projectOrderBy',
  'showSleepingWorkspaces',
  'hideDefaultBranchWorkspace',
  'hideAutomationGeneratedWorkspaces',
  'hideCliCreatedWorkspaces',
  'hideDetachedHeadWorkspaces',
  'hideWorkspacesFromOtherDevices',
  'alwaysShowDefaultBranchWorkspace',
  'showDotfilesByWorktree',
  'filterRepoIds',
  'acknowledgedAgentsByPaneKey'
] as const satisfies readonly (keyof PersistedUIWriteBaseline)[]

/** Pick the writer-owned fields off a hydrated mirror (a structural superset). */
export function capturePersistedUIWriteBaseline(
  mirror: PersistedUIWriteBaseline
): PersistedUIWriteBaseline {
  const captured = {} as Record<string, unknown>
  for (const field of PERSISTED_UI_WRITE_BASELINE_FIELDS) {
    captured[field] = mirror[field]
  }
  return captured as PersistedUIWriteBaseline
}

function shallowRecordEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  const aKeys = Object.keys(a)
  return aKeys.length === Object.keys(b).length && aKeys.every((key) => Object.is(a[key], b[key]))
}

function stringArrayEqual(a: readonly string[], b: readonly string[]): boolean {
  return a === b || (a.length === b.length && a.every((value, i) => value === b[i]))
}

function writeFieldEqual(field: keyof PersistedUIWriteBaseline, a: unknown, b: unknown): boolean {
  if (field === 'filterRepoIds') {
    return stringArrayEqual(a as readonly string[], b as readonly string[])
  }
  if (field === 'showDotfilesByWorktree' || field === 'acknowledgedAgentsByPaneKey') {
    return shallowRecordEqual(
      a as Record<string, unknown> | undefined,
      b as Record<string, unknown> | undefined
    )
  }
  return Object.is(a, b)
}

/** Fields whose current mirror value diverges from the baseline, valued from the mirror. */
export function diffPersistedUIWriteFields(
  current: PersistedUIWriteBaseline,
  baseline: PersistedUIWriteBaseline
): Partial<PersistedUIWriteBaseline> {
  const changed = {} as Record<string, unknown>
  for (const field of PERSISTED_UI_WRITE_BASELINE_FIELDS) {
    if (!writeFieldEqual(field, current[field], baseline[field])) {
      changed[field] = current[field]
    }
  }
  return changed as Partial<PersistedUIWriteBaseline>
}

/** Convert a mirror-shaped field patch to the ui.set wire shape. */
export function persistedUIWriteFieldsToWireUpdate(
  fields: Partial<PersistedUIWriteBaseline>
): Partial<PersistedUIState> {
  const { showSleepingWorkspaces, filterRepoIds, ...rest } = fields
  const update: Partial<PersistedUIState> = { ...rest }
  if ('showSleepingWorkspaces' in fields) {
    // The mirror keeps the positive form; the durable file keeps the hide form.
    update.hideSleepingWorkspaces = showSleepingWorkspaces !== true
  }
  if ('filterRepoIds' in fields) {
    // Why: the store keeps this readonly for identity stability, but PersistedUI crosses to
    // main, which owns a mutable array — copy at the boundary rather than widening the wire type.
    update.filterRepoIds = [...(filterRepoIds ?? [])]
  }
  return update
}
