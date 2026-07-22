import type { WorkspaceSessionState } from '../../../shared/types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import {
  GLOBAL_WORKSPACE_SESSION_FIELDS,
  WORKSPACE_SESSION_FIELD_OWNERSHIP
} from './workspace-session-host-field-ownership'
import {
  buildWorktreeIdByFileId,
  buildWorktreeIdByTabId,
  isWorkspaceSessionRecord,
  mergeWorkspaceSessionArrayField,
  mergeWorkspaceSessionRecordField,
  type WorkspaceSessionRecord
} from './workspace-session-host-records'

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
 *  - hostPrivate: main/runtime-owned; omitted from renderer merge and writes.
 *  - worktreeKeyed: Record keyed by worktree id; each entry goes to its owner.
 *  - worktreeArray: array of worktree ids; each id goes to its owner.
 *  - tabKeyed: Record keyed by tab id; follows the owning tab's worktree.
 *  - browserWorkspaceKeyed: Record keyed by browser-workspace id; follows the
 *    page record's own worktreeId.
 *  - fileKeyed: Record keyed by editor file id; follows the open file's worktree.
 *  - sleepingAgentKeyed: Record keyed by pane key; follows the record's worktreeId. */
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

function assignWorktreeKeyed(
  slices: HostSessionSlices,
  template: WorkspaceSessionState,
  field: keyof WorkspaceSessionState,
  value: unknown,
  ctx: SplitContext
): void {
  if (!isWorkspaceSessionRecord(value)) {
    return
  }
  for (const [worktreeId, entry] of Object.entries(value)) {
    const host = ctx.hostIdByWorktreeId(worktreeId)
    const slice = ensureSlice(slices, host, template) as WorkspaceSessionRecord
    const target = (slice[field] ??= {}) as WorkspaceSessionRecord
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
  if (!isWorkspaceSessionRecord(value)) {
    return
  }
  for (const [key, entry] of Object.entries(value)) {
    const worktreeId = resolveWorktreeId(key, entry)
    const host = worktreeId ? ctx.hostIdByWorktreeId(worktreeId) : LOCAL_EXECUTION_HOST_ID
    const slice = ensureSlice(slices, host, template) as WorkspaceSessionRecord
    const target = (slice[field] ??= {}) as WorkspaceSessionRecord
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
  for (const field of GLOBAL_WORKSPACE_SESSION_FIELDS) {
    if (Object.hasOwn(state, field)) {
      ;(template as WorkspaceSessionRecord)[field] = state[field]
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

  const localSlice = slices[LOCAL_EXECUTION_HOST_ID] as WorkspaceSessionRecord

  for (const field of Object.keys(
    WORKSPACE_SESSION_FIELD_OWNERSHIP
  ) as (keyof WorkspaceSessionState)[]) {
    const ownership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
    const value = state[field]
    if (value === undefined) {
      continue
    }
    // Why: a present-but-empty container ({} / []) must survive the round trip.
    // Seed it on 'local' so merge reproduces the field instead of dropping it.
    if (ownership !== 'global' && ownership !== 'hostPrivate') {
      localSlice[field] ??= Array.isArray(value) ? [] : {}
    }
    switch (ownership) {
      case 'global':
        // Already on the template / local slice.
        break
      case 'hostPrivate':
        // Main preserves this field while rebasing renderer writes onto host authority.
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
          const slice = ensureSlice(slices, host, template) as WorkspaceSessionRecord
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
            isWorkspaceSessionRecord(record) && typeof record.worktreeId === 'string'
              ? record.worktreeId
              : undefined,
          ctx
        )
        break
      case 'paneKeyed':
        assignKeyedByResolvedWorktree(
          slices,
          template,
          field,
          value,
          (paneKey) => {
            const separator = paneKey.lastIndexOf(':')
            return separator > 0
              ? ctx.worktreeIdByTabId.get(paneKey.slice(0, separator))
              : undefined
          },
          ctx
        )
        break
      case 'surfaceTombstoneKeyed':
        assignKeyedByResolvedWorktree(
          slices,
          template,
          field,
          value,
          (_paneKey, record) =>
            isWorkspaceSessionRecord(record) && typeof record.worktreeId === 'string'
              ? record.worktreeId
              : undefined,
          ctx
        )
        break
    }
  }

  return slices
}

/** Inverse of split: combine per-host slices into one unified session. Global
 *  fields are taken from the 'local' slice (it owns them); worktree/tab-scoped
 *  maps are unioned across all hosts. Tolerates missing or partial slices. */
export function mergeWorkspaceSessionsFromHosts(slices: HostSessionSlices): WorkspaceSessionState {
  const out = {} as WorkspaceSessionState
  const local = slices[LOCAL_EXECUTION_HOST_ID]

  // Global fields: 'local' wins. Fall back to any slice that has them so a
  // standalone non-local slice still yields sane active pointers.
  for (const field of GLOBAL_WORKSPACE_SESSION_FIELDS) {
    const fromLocal = local?.[field]
    if (fromLocal !== undefined) {
      ;(out as WorkspaceSessionRecord)[field] = fromLocal
      continue
    }
    for (const slice of Object.values(slices)) {
      if (slice && slice[field] !== undefined) {
        ;(out as WorkspaceSessionRecord)[field] = slice[field]
        break
      }
    }
  }

  for (const slice of Object.values(slices)) {
    if (!slice) {
      continue
    }
    for (const field of Object.keys(
      WORKSPACE_SESSION_FIELD_OWNERSHIP
    ) as (keyof WorkspaceSessionState)[]) {
      const ownership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
      if (ownership === 'global' || ownership === 'hostPrivate') {
        continue
      }
      if (ownership === 'worktreeArray') {
        mergeWorkspaceSessionArrayField(out as WorkspaceSessionRecord, field, slice)
      } else {
        mergeWorkspaceSessionRecordField(out as WorkspaceSessionRecord, field, slice)
      }
    }
  }

  return out
}
