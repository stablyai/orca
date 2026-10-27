import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'

/** Capture hydrated baseline and persist only locally changed fields: shared desktop/web/mobile UI snapshots otherwise overwrite peers’ disjoint updates (STA-5781). */
export type PersistedUIWriteBaseline = {
  sidebarWidth: number
  sidebarOpen: boolean
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
  workspaceHostScope: PersistedUIState['workspaceHostScope']
  visibleWorkspaceHostIds: PersistedUIState['visibleWorkspaceHostIds']
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  alwaysShowDefaultBranchWorkspace: boolean
  explorerDisplayRootByWorktree: Record<string, string>
  showDotfilesByWorktree: Record<string, boolean>
  filterRepoIds: readonly string[]
  acknowledgedAgentsByPaneKey: Record<string, number>
  activityClearedAtByPaneKey: Record<string, number>
  manuallyUnreadTurnsByPaneKey: Record<string, number>
}

// Require exhaustive Record coverage; keyof arrays validate members but silently omit new fields, losing persistence (ui-state-schema-parity.ts).
const PERSISTED_UI_WRITE_BASELINE_FIELD_SET = {
  sidebarWidth: true,
  sidebarOpen: true,
  rightSidebarOpen: true,
  rightSidebarTab: true,
  rightSidebarExplorerView: true,
  rightSidebarWidth: true,
  markdownTocPanelWidth: true,
  combinedDiffFileTreeWidth: true,
  groupBy: true,
  sortBy: true,
  projectOrderBy: true,
  showSleepingWorkspaces: true,
  workspaceHostScope: true,
  visibleWorkspaceHostIds: true,
  hideDefaultBranchWorkspace: true,
  hideAutomationGeneratedWorkspaces: true,
  hideCliCreatedWorkspaces: true,
  hideDetachedHeadWorkspaces: true,
  hideWorkspacesFromOtherDevices: true,
  alwaysShowDefaultBranchWorkspace: true,
  explorerDisplayRootByWorktree: true,
  showDotfilesByWorktree: true,
  filterRepoIds: true,
  acknowledgedAgentsByPaneKey: true,
  activityClearedAtByPaneKey: true,
  manuallyUnreadTurnsByPaneKey: true
} satisfies Record<keyof PersistedUIWriteBaseline, true>

export const PERSISTED_UI_WRITE_BASELINE_FIELDS = Object.keys(
  PERSISTED_UI_WRITE_BASELINE_FIELD_SET
) as readonly (keyof PersistedUIWriteBaseline)[]

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

/** Compares collection fields by value so hydration does not produce redundant persistence writes from new identities. */
function writeFieldEqual(field: keyof PersistedUIWriteBaseline, a: unknown, b: unknown): boolean {
  if (field === 'filterRepoIds') {
    return stringArrayEqual(a as readonly string[], b as readonly string[])
  }
  if (field === 'visibleWorkspaceHostIds') {
    return a === b || (Array.isArray(a) && Array.isArray(b) && stringArrayEqual(a, b))
  }
  if (
    field === 'explorerDisplayRootByWorktree' ||
    field === 'showDotfilesByWorktree' ||
    field === 'acknowledgedAgentsByPaneKey' ||
    field === 'activityClearedAtByPaneKey' ||
    field === 'manuallyUnreadTurnsByPaneKey'
  ) {
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

/** Build wire patch key-by-key for excess-property checks; spreads could send renamed store fields and make strict paired UiUpdate reject all fields. */
export function persistedUIWriteFieldsToWireUpdate(
  fields: Partial<PersistedUIWriteBaseline>
): Partial<PersistedUIState> {
  const update: Partial<PersistedUIState> = {}
  for (const field of PERSISTED_UI_WRITE_BASELINE_FIELDS) {
    if (!(field in fields)) {
      continue
    }
    if (field === 'showSleepingWorkspaces') {
      // The mirror keeps the positive form; the durable file keeps the hide form.
      update.hideSleepingWorkspaces = fields.showSleepingWorkspaces !== true
    } else if (field === 'filterRepoIds') {
      // Copy readonly store arrays at mutable main wire boundary; keep selector identity guarantees local.
      update.filterRepoIds = [...(fields.filterRepoIds ?? [])]
    } else {
      assignSameNameWireField(
        update,
        field,
        fields[field] as PersistedUIWriteBaseline[typeof field]
      )
    }
  }
  return update
}

type SameNameWriteField = Exclude<
  keyof PersistedUIWriteBaseline,
  'showSleepingWorkspaces' | 'filterRepoIds'
>

// Compile-check nonspecial mirror fields against wire names/types so renames or drift cannot silently break persistence.
type MisassignableWireField = {
  [K in SameNameWriteField]: PersistedUIWriteBaseline[K] extends PersistedUIState[K] ? never : K
}[SameNameWriteField]
const assertSameNameFieldsAssignable: MisassignableWireField extends never ? true : never = true
void assertSameNameFieldsAssignable

function assignSameNameWireField<K extends SameNameWriteField>(
  update: Partial<PersistedUIState>,
  field: K,
  value: PersistedUIWriteBaseline[K]
): void {
  ;(update as Record<SameNameWriteField, unknown>)[field] = value
}
