import type { WorkspaceSessionState } from '../../../shared/types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'

/**
 * Split / merge the unified WorkspaceSessionState across per-host partitions.
 *
 * Persistence stores one session slice per execution host (see
 * src/main/persistence.ts host-keyed getWorkspaceSession/setWorkspaceSession).
 * The renderer holds a single unified session, so before writing it must
 * partition each worktree-scoped slice to its owning host, and on hydration it
 * must merge the per-host slices back into one.
 *
 * Field classification lives in FIELD_OWNERSHIP below and is checked for
 * exhaustiveness at compile time, mirroring SESSION_RELEVANT_FIELDS in
 * workspace-session.ts. The remote-workspace SSH projection
 * (src/shared/remote-workspace-session-projection.ts) enumerates the same
 * worktree/tab-scoped fields by worktree-path; the two surfaces are kept
 * deliberately aligned — when a new worktree-scoped field is added there it
 * must be classified here too.
 */

export type HostSessionSlices = Partial<Record<ExecutionHostId, WorkspaceSessionState>>

export type HostIdByWorktreeId = (worktreeId: string) => ExecutionHostId

/** How a WorkspaceSessionState field is partitioned across hosts.
 *  - global: client-wide; always stays in the 'local' slice.
 *  - worktreeKeyed: Record keyed by worktree id; each entry goes to its owner.
 *  - worktreeArray: array of worktree ids; each id goes to its owner.
 *  - tabKeyed: Record keyed by tab id; follows the owning tab's worktree.
 *  - browserWorkspaceKeyed: Record keyed by browser-workspace id; follows the
 *    page record's own worktreeId.
 *  - fileKeyed: Record keyed by editor file id; follows the open file's worktree.
 *  - sleepingAgentKeyed: Record keyed by pane key; follows the record's worktreeId. */
type FieldOwnership =
  | 'global'
  | 'worktreeKeyed'
  | 'worktreeArray'
  | 'tabKeyed'
  | 'browserWorkspaceKeyed'
  | 'fileKeyed'
  | 'sleepingAgentKeyed'

const FIELD_OWNERSHIP = {
  activeRepoId: 'global',
  activeWorktreeId: 'global',
  activeTabId: 'global',
  browserUrlHistory: 'global',
  // Why: SSH-connection ids, not worktrees. SSH stays in the local blob today
  // (the runtime split intentionally leaves SSH ownership unchanged), so this
  // reconnect list rides along in 'local'.
  activeConnectionIdsAtShutdown: 'global',
  tabsByWorktree: 'worktreeKeyed',
  openFilesByWorktree: 'worktreeKeyed',
  activeFileIdByWorktree: 'worktreeKeyed',
  activeBrowserTabIdByWorktree: 'worktreeKeyed',
  activeTabTypeByWorktree: 'worktreeKeyed',
  activeTabIdByWorktree: 'worktreeKeyed',
  browserTabsByWorktree: 'worktreeKeyed',
  unifiedTabs: 'worktreeKeyed',
  tabGroups: 'worktreeKeyed',
  tabGroupLayouts: 'worktreeKeyed',
  activeGroupIdByWorktree: 'worktreeKeyed',
  lastVisitedAtByWorktreeId: 'worktreeKeyed',
  defaultTerminalTabsAppliedByWorktreeId: 'worktreeKeyed',
  activeWorkspaceKey: 'global',
  activeWorktreeIdsOnShutdown: 'worktreeArray',
  terminalLayoutsByTabId: 'tabKeyed',
  remoteSessionIdsByTabId: 'tabKeyed',
  browserPagesByWorkspace: 'browserWorkspaceKeyed',
  markdownFrontmatterVisible: 'fileKeyed',
  sleepingAgentSessionsByPaneKey: 'sleepingAgentKeyed'
} as const satisfies Record<keyof WorkspaceSessionState, FieldOwnership>

// Why: a new WorkspaceSessionState field must be classified above or the split
// would silently drop it from every non-local host. This fails compilation
// until the table is updated, mirroring the _exhaustive guard in
// workspace-session.ts.
type _MissingOwnership = Exclude<keyof WorkspaceSessionState, keyof typeof FIELD_OWNERSHIP>
const _exhaustive: [_MissingOwnership] extends [never] ? true : never = true
void _exhaustive

const GLOBAL_FIELDS = (Object.keys(FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]).filter(
  (field) => FIELD_OWNERSHIP[field] === 'global'
)

type AnyRecord = Record<string, unknown>

function isPlainRecord(value: unknown): value is AnyRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Build tabId → worktreeId from both the legacy and unified tab models so
 *  tab-keyed maps (terminal layouts, remote session ids) follow their tab. */
function buildWorktreeIdByTabId(state: WorkspaceSessionState): Map<string, string> {
  const byTab = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
    for (const tab of tabs) {
      byTab.set(tab.id, worktreeId)
    }
  }
  // Why: unified tabs carry their own worktreeId; index it too so layouts for a
  // tab that exists only in the unified model still resolve to an owner.
  for (const tabs of Object.values(state.unifiedTabs ?? {})) {
    for (const tab of tabs) {
      if (!byTab.has(tab.id)) {
        byTab.set(tab.id, tab.worktreeId)
      }
    }
  }
  return byTab
}

/** Build editor-file id → worktreeId so markdownFrontmatterVisible (keyed by
 *  file id) follows the file's worktree. */
function buildWorktreeIdByFileId(state: WorkspaceSessionState): Map<string, string> {
  const byFile = new Map<string, string>()
  for (const files of Object.values(state.openFilesByWorktree ?? {})) {
    for (const file of files) {
      // PersistedOpenFile.filePath is the editor tab/file id used elsewhere.
      byFile.set(file.filePath, file.worktreeId)
    }
  }
  return byFile
}

type SplitContext = {
  hostIdByWorktreeId: HostIdByWorktreeId
  worktreeIdByTabId: Map<string, string>
  worktreeIdByFileId: Map<string, string>
}

function ensureSlice(
  slices: HostSessionSlices,
  hostId: ExecutionHostId,
  template: WorkspaceSessionState
): WorkspaceSessionState {
  let slice = slices[hostId]
  if (!slice) {
    // Why: clone the global fields onto every slice so a partition read in
    // isolation still carries the active pointers; merge later prefers 'local'.
    slice = { ...template }
    slices[hostId] = slice
  }
  return slice
}

function hostForWorktree(
  ctx: SplitContext,
  worktreeId: string | undefined
): ExecutionHostId | null {
  if (!worktreeId) {
    return null
  }
  return ctx.hostIdByWorktreeId(worktreeId)
}

function assignWorktreeKeyed(
  slices: HostSessionSlices,
  template: WorkspaceSessionState,
  field: keyof WorkspaceSessionState,
  value: unknown,
  ctx: SplitContext
): void {
  if (!isPlainRecord(value)) {
    return
  }
  for (const [worktreeId, entry] of Object.entries(value)) {
    const host = ctx.hostIdByWorktreeId(worktreeId)
    const slice = ensureSlice(slices, host, template) as AnyRecord
    const target = (slice[field] ??= {}) as AnyRecord
    target[worktreeId] = entry
  }
}

function assignKeyedByResolvedWorktree(
  slices: HostSessionSlices,
  template: WorkspaceSessionState,
  field: keyof WorkspaceSessionState,
  value: unknown,
  resolveWorktreeId: (key: string, entry: unknown) => string | undefined,
  ctx: SplitContext
): void {
  if (!isPlainRecord(value)) {
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    const worktreeId = resolveWorktreeId(key, entry)
    const host = hostForWorktree(ctx, worktreeId) ?? LOCAL_EXECUTION_HOST_ID
    const slice = ensureSlice(slices, host, template) as AnyRecord
    const target = (slice[field] ??= {}) as AnyRecord
    target[key] = entry
  }
}

/** Partition a unified session into per-host slices keyed by ExecutionHostId.
 *  Global fields are copied to the 'local' slice; worktree-scoped data is routed
 *  to its owner host. Entries whose owning worktree is unknown (orphan tabs,
 *  files, pages) stay in 'local' so they are never silently dropped. */
export function splitWorkspaceSessionByHost(
  state: WorkspaceSessionState,
  hostIdByWorktreeId: HostIdByWorktreeId
): HostSessionSlices {
  // Template carries only the global fields; per-field assigners add the rest.
  // Why: copy only own-keys so a partial patch (where most globals are absent)
  // does not inject `undefined` values that would clobber persisted state when
  // the slice is applied as a patch. Intentional `undefined` keys are preserved.
  const template = {} as WorkspaceSessionState
  for (const field of GLOBAL_FIELDS) {
    if (Object.hasOwn(state, field)) {
      ;(template as AnyRecord)[field] = state[field]
    }
  }

  const slices: HostSessionSlices = {}
  // Why: 'local' must always exist — it owns the global fields and is the
  // hydration anchor even when every worktree belongs to a runtime host.
  ensureSlice(slices, LOCAL_EXECUTION_HOST_ID, template)

  const ctx: SplitContext = {
    hostIdByWorktreeId,
    worktreeIdByTabId: buildWorktreeIdByTabId(state),
    worktreeIdByFileId: buildWorktreeIdByFileId(state)
  }

  const localSlice = slices[LOCAL_EXECUTION_HOST_ID] as AnyRecord

  for (const field of Object.keys(FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]) {
    const ownership = FIELD_OWNERSHIP[field]
    const value = state[field]
    if (value === undefined) {
      continue
    }
    // Why: a present-but-empty container ({} / []) must survive the round trip.
    // Seed it on 'local' so merge reproduces the field instead of dropping it.
    if (ownership !== 'global') {
      localSlice[field] ??= Array.isArray(value) ? [] : {}
    }
    switch (ownership) {
      case 'global':
        // Already on the template / local slice.
        break
      case 'worktreeKeyed':
        assignWorktreeKeyed(slices, template, field, value, ctx)
        break
      case 'worktreeArray': {
        if (!Array.isArray(value)) {
          break
        }
        for (const worktreeId of value as string[]) {
          const host = ctx.hostIdByWorktreeId(worktreeId)
          const slice = ensureSlice(slices, host, template) as AnyRecord
          const target = (slice[field] ??= []) as string[]
          target.push(worktreeId)
        }
        break
      }
      case 'tabKeyed':
        assignKeyedByResolvedWorktree(
          slices,
          template,
          field,
          value,
          (tabId) => ctx.worktreeIdByTabId.get(tabId),
          ctx
        )
        break
      case 'fileKeyed':
        assignKeyedByResolvedWorktree(
          slices,
          template,
          field,
          value,
          (fileId) => ctx.worktreeIdByFileId.get(fileId),
          ctx
        )
        break
      case 'browserWorkspaceKeyed':
        assignKeyedByResolvedWorktree(
          slices,
          template,
          field,
          value,
          (_workspaceId, pages) => {
            const first = Array.isArray(pages)
              ? (pages[0] as { worktreeId?: string } | undefined)
              : undefined
            return first?.worktreeId
          },
          ctx
        )
        break
      case 'sleepingAgentKeyed':
        assignKeyedByResolvedWorktree(
          slices,
          template,
          field,
          value,
          (_paneKey, record) =>
            isPlainRecord(record) && typeof record.worktreeId === 'string'
              ? record.worktreeId
              : undefined,
          ctx
        )
        break
    }
  }

  return slices
}

function mergeRecordField(
  out: AnyRecord,
  field: keyof WorkspaceSessionState,
  slice: WorkspaceSessionState
): void {
  const value = slice[field]
  if (!isPlainRecord(value)) {
    return
  }
  const target = (out[field] ??= {}) as AnyRecord
  Object.assign(target, value)
}

function mergeArrayField(
  out: AnyRecord,
  field: keyof WorkspaceSessionState,
  slice: WorkspaceSessionState
): void {
  const value = slice[field]
  if (!Array.isArray(value)) {
    return
  }
  const target = (out[field] ??= []) as unknown[]
  target.push(...value)
}

/** Inverse of split: combine per-host slices into one unified session. Global
 *  fields are taken from the 'local' slice (it owns them); worktree/tab-scoped
 *  maps are unioned across all hosts. Tolerates missing or partial slices. */
export function mergeWorkspaceSessionsFromHosts(slices: HostSessionSlices): WorkspaceSessionState {
  const out = {} as WorkspaceSessionState
  const local = slices[LOCAL_EXECUTION_HOST_ID]

  // Global fields: 'local' wins. Fall back to any slice that has them so a
  // standalone non-local slice still yields sane active pointers.
  for (const field of GLOBAL_FIELDS) {
    const fromLocal = local?.[field]
    if (fromLocal !== undefined) {
      ;(out as AnyRecord)[field] = fromLocal
      continue
    }
    for (const slice of Object.values(slices)) {
      if (slice && slice[field] !== undefined) {
        ;(out as AnyRecord)[field] = slice[field]
        break
      }
    }
  }

  for (const slice of Object.values(slices)) {
    if (!slice) {
      continue
    }
    for (const field of Object.keys(FIELD_OWNERSHIP) as (keyof WorkspaceSessionState)[]) {
      const ownership = FIELD_OWNERSHIP[field]
      if (ownership === 'global') {
        continue
      }
      if (ownership === 'worktreeArray') {
        mergeArrayField(out as AnyRecord, field, slice)
      } else {
        mergeRecordField(out as AnyRecord, field, slice)
      }
    }
  }

  return out
}
