import { isHostGatedUiField } from '../../../../shared/host-gated-ui-fields'
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

function writeFieldEqual(field: keyof PersistedUIWriteBaseline, a: unknown, b: unknown): boolean {
  // Why by value: every drag and every hydration allocates a fresh order array.
  // Compared by identity, each broadcast would read as an unflushed local edit
  // and each writer arm would diff non-empty — a write/echo cycle.
  if (
    field === 'filterRepoIds' ||
    field === 'sessionsGridTabOrder' ||
    field === 'sessionsGridHiddenTabIds'
  ) {
    return stringArrayEqual(a as readonly string[], b as readonly string[])
  }
  if (
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

const UNRECOGNIZED_KEY_MESSAGE = /unrecognized key/i

/**
 * The part of a rejected batch to stop re-sending. Only an `invalid_argument` rejection
 * quarantines (a transport failure returns null and stays dirty for the next edit): the
 * strict paired-host schema names the unknown keys, so those are folded; if it names none,
 * the host-gated members are the only keys an old host can refuse; failing that, the whole batch.
 */
export function quarantineRejectedPersistedUIWriteFields(
  error: unknown,
  changed: Partial<PersistedUIWriteBaseline>
): Partial<PersistedUIWriteBaseline> | null {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  if (code !== 'invalid_argument') {
    return null
  }
  const sent = Object.keys(changed) as (keyof PersistedUIWriteBaseline)[]
  const named =
    typeof message === 'string' && UNRECOGNIZED_KEY_MESSAGE.test(message)
      ? [...message.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '')
      : []
  const refused = sent.filter((field) => named.includes(wireNameOf(field)))
  const gated = sent.filter(isHostGatedUiField)
  const quarantined = refused.length > 0 ? refused : gated.length > 0 ? gated : sent
  return Object.fromEntries(quarantined.map((field) => [field, changed[field]]))
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
    } else if (field === 'filterRepoIds') {
      // Why: the store keeps this readonly for identity stability, but PersistedUI crosses to
      // main, which owns a mutable array — copy at the boundary rather than widening the wire type.
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
  value: PersistedUIWriteBaseline[K]
): void {
  ;(update as Record<SameNameWriteField, unknown>)[field] = value
}
