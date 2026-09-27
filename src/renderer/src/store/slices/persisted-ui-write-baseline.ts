import { shallow } from 'zustand/vanilla/shallow'
import { serializeSessionGridWheelTarget } from '../../../../shared/session-grid-types'
import type { PersistedUIState } from '../../../../shared/persisted-ui-state-types'
import type {
  SessionGridFilter,
  SessionGridLayoutPreset,
  SessionGridScrollMode,
  SessionGridStateFilter,
  SessionGridWheelTarget
} from '../../../../shared/session-grid-types'

// Why field-level (STA-5781): PersistedUIState is edited concurrently by desktop, web and mobile,
// so the writer diffs against this hydrated baseline and persists only what this client changed.
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
  activityClearedAtByPaneKey: Record<string, number>
  manuallyUnreadTurnsByPaneKey: Record<string, number>
  // Session grid layout: shared across windows and paired clients by design.
  sessionsGridPreset: SessionGridLayoutPreset
  sessionsGridZoom: number
  sessionsGridShowEmpty: boolean
  sessionsGridFilter: SessionGridFilter
  sessionsGridStateFilter: SessionGridStateFilter
  sessionsGridScrollMode: SessionGridScrollMode
  sessionsGridWheelTarget: SessionGridWheelTarget
  sessionsGridTabOrder: string[]
  sessionsGridHiddenTabIds: string[]
}

// Why `satisfies Record<...>` rather than a keyof[] annotation: a plain `satisfies
// readonly (keyof ...)[]` only validates listed elements, so a field added to the
// type but forgotten here would silently never persist again — the exact bug class
// this module exists to close (see ui-state-schema-parity.ts for the same lesson).
const PERSISTED_UI_WRITE_BASELINE_FIELD_SET = {
  sidebarWidth: true,
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
  hideDefaultBranchWorkspace: true,
  hideAutomationGeneratedWorkspaces: true,
  hideCliCreatedWorkspaces: true,
  hideDetachedHeadWorkspaces: true,
  hideWorkspacesFromOtherDevices: true,
  alwaysShowDefaultBranchWorkspace: true,
  showDotfilesByWorktree: true,
  filterRepoIds: true,
  acknowledgedAgentsByPaneKey: true,
  activityClearedAtByPaneKey: true,
  manuallyUnreadTurnsByPaneKey: true,
  sessionsGridPreset: true,
  sessionsGridZoom: true,
  sessionsGridShowEmpty: true,
  sessionsGridFilter: true,
  sessionsGridStateFilter: true,
  sessionsGridScrollMode: true,
  sessionsGridWheelTarget: true,
  sessionsGridTabOrder: true,
  sessionsGridHiddenTabIds: true
} satisfies Record<keyof PersistedUIWriteBaseline, true>

export const PERSISTED_UI_WRITE_BASELINE_FIELDS = Object.keys(
  PERSISTED_UI_WRITE_BASELINE_FIELD_SET
).filter(isPersistedUIWriteField)

export function isPersistedUIWriteField(field: string): field is keyof PersistedUIWriteBaseline {
  return Object.hasOwn(PERSISTED_UI_WRITE_BASELINE_FIELD_SET, field)
}

/** Pick the writer-owned fields off a hydrated mirror (a structural superset). */
export function capturePersistedUIWriteBaseline(
  mirror: PersistedUIWriteBaseline
): PersistedUIWriteBaseline {
  return {
    sidebarWidth: mirror.sidebarWidth,
    rightSidebarOpen: mirror.rightSidebarOpen,
    rightSidebarTab: mirror.rightSidebarTab,
    rightSidebarExplorerView: mirror.rightSidebarExplorerView,
    rightSidebarWidth: mirror.rightSidebarWidth,
    markdownTocPanelWidth: mirror.markdownTocPanelWidth,
    combinedDiffFileTreeWidth: mirror.combinedDiffFileTreeWidth,
    groupBy: mirror.groupBy,
    sortBy: mirror.sortBy,
    projectOrderBy: mirror.projectOrderBy,
    showSleepingWorkspaces: mirror.showSleepingWorkspaces,
    hideDefaultBranchWorkspace: mirror.hideDefaultBranchWorkspace,
    hideAutomationGeneratedWorkspaces: mirror.hideAutomationGeneratedWorkspaces,
    hideCliCreatedWorkspaces: mirror.hideCliCreatedWorkspaces,
    hideDetachedHeadWorkspaces: mirror.hideDetachedHeadWorkspaces,
    hideWorkspacesFromOtherDevices: mirror.hideWorkspacesFromOtherDevices,
    alwaysShowDefaultBranchWorkspace: mirror.alwaysShowDefaultBranchWorkspace,
    showDotfilesByWorktree: mirror.showDotfilesByWorktree,
    filterRepoIds: mirror.filterRepoIds,
    acknowledgedAgentsByPaneKey: mirror.acknowledgedAgentsByPaneKey,
    activityClearedAtByPaneKey: mirror.activityClearedAtByPaneKey,
    manuallyUnreadTurnsByPaneKey: mirror.manuallyUnreadTurnsByPaneKey,
    sessionsGridPreset: mirror.sessionsGridPreset,
    sessionsGridZoom: mirror.sessionsGridZoom,
    sessionsGridShowEmpty: mirror.sessionsGridShowEmpty,
    sessionsGridFilter: mirror.sessionsGridFilter,
    sessionsGridStateFilter: mirror.sessionsGridStateFilter,
    sessionsGridScrollMode: mirror.sessionsGridScrollMode,
    sessionsGridWheelTarget: mirror.sessionsGridWheelTarget,
    sessionsGridTabOrder: mirror.sessionsGridTabOrder,
    sessionsGridHiddenTabIds: mirror.sessionsGridHiddenTabIds
  }
}

function writeFieldEqual(field: keyof PersistedUIWriteBaseline, a: unknown, b: unknown): boolean {
  // Why by value: every drag and every hydration allocates a fresh order array.
  // Compared by identity, each broadcast would read as an unflushed local edit
  // and each writer arm would diff non-empty — a write/echo cycle.
  if (
    field === 'filterRepoIds' ||
    field === 'sessionsGridTabOrder' ||
    field === 'sessionsGridHiddenTabIds'
  ) {
    return shallow(a, b)
  }
  if (
    field === 'showDotfilesByWorktree' ||
    field === 'acknowledgedAgentsByPaneKey' ||
    field === 'activityClearedAtByPaneKey' ||
    field === 'manuallyUnreadTurnsByPaneKey'
  ) {
    return shallow(a, b)
  }
  return Object.is(a, b)
}

/** Fields whose current mirror value diverges from the baseline, valued from the mirror. */
export function diffPersistedUIWriteFields(
  current: PersistedUIWriteBaseline,
  baseline: PersistedUIWriteBaseline
): Partial<PersistedUIWriteBaseline> {
  const changed: Partial<PersistedUIWriteBaseline> = {}
  const copy = <K extends keyof PersistedUIWriteBaseline>(field: K): void => {
    changed[field] = current[field]
  }
  for (const field of PERSISTED_UI_WRITE_BASELINE_FIELDS) {
    if (!writeFieldEqual(field, current[field], baseline[field])) {
      copy(field)
    }
  }
  return changed
}

const UNRECOGNIZED_KEY_MESSAGE = /unrecognized key/i

/** Only explicitly named unknown wire keys can be removed from the dirty baseline. */
export function quarantineRejectedPersistedUIWriteFields(
  error: unknown,
  changed: Partial<PersistedUIWriteBaseline>
): Partial<PersistedUIWriteBaseline> | null {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    error.code !== 'invalid_argument'
  ) {
    return null
  }
  const message = 'message' in error ? error.message : undefined
  const sent = Object.keys(changed).filter(isPersistedUIWriteField)
  const named =
    typeof message === 'string' && UNRECOGNIZED_KEY_MESSAGE.test(message)
      ? [...message.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '')
      : []
  const refused = sent.filter((field) => named.includes(wireNameOf(field)))
  return refused.length > 0
    ? Object.fromEntries(refused.map((field) => [field, changed[field]]))
    : null
}

function wireNameOf(field: keyof PersistedUIWriteBaseline): string {
  return field === 'showSleepingWorkspaces' ? 'hideSleepingWorkspaces' : field
}

/**
 * Convert a mirror-shaped field patch to the ui.set wire shape. Built key-by-key
 * (no spread): a spread is not excess-property-checked, so a future mirror field
 * whose store name differs from its wire name would ship a bogus key and make the
 * strict paired-host UiUpdate schema reject the whole payload.
 */
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
    } else if (field === 'sessionsGridWheelTarget') {
      if (fields.sessionsGridWheelTarget !== undefined) {
        update.sessionsGridWheelTarget = serializeSessionGridWheelTarget(
          fields.sessionsGridWheelTarget
        )
      }
    } else if (field === 'filterRepoIds') {
      // Why: the store keeps this readonly for identity stability, but PersistedUI crosses to
      // main, which owns a mutable array — copy at the boundary rather than widening the wire type.
      update.filterRepoIds = [...(fields.filterRepoIds ?? [])]
    } else {
      assignSameNameWireField(update, field, fields[field])
    }
  }
  return update
}

type SameNameWriteField = Exclude<
  keyof PersistedUIWriteBaseline,
  'showSleepingWorkspaces' | 'filterRepoIds' | 'sessionsGridWheelTarget'
>

// Compile check: every non-special mirror field must exist on PersistedUIState
// under the same name with an assignable type — indexing PersistedUIState[K]
// fails to compile for a renamed field, and the conditional flags a type drift.
type MisassignableWireField = {
  [K in SameNameWriteField]: PersistedUIWriteBaseline[K] extends PersistedUIState[K] ? never : K
}[SameNameWriteField]
const assertSameNameFieldsAssignable: MisassignableWireField extends never ? true : never = true
void assertSameNameFieldsAssignable

function assignSameNameWireField<K extends SameNameWriteField>(
  update: Partial<PersistedUIState>,
  field: K,
  value: PersistedUIState[K]
): void {
  update[field] = value
}
