import type { ExecutionHostId } from '../../../shared/execution-host'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { WORKSPACE_SESSION_FIELD_OWNERSHIP } from '../../../shared/workspace-session-host-field-ownership'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { isWorkspaceSessionRecord } from '../../../shared/workspace-session-host-records'
import {
  buildWorktreeIdByTabId,
  worktreeIdForPaneKey
} from '../../../shared/workspace-session-host-records'
import { PARKABLE_HOST_SESSION_FIELDS } from './workspace-session-host-contention'
import type { HostSessionSlices } from './workspace-session-host-split'
import {
  hostHasAnsweredForTarget,
  type RemoteWorkspaceTestimonyState
} from './remote-workspace-host-testimony'

/**
 * Terminal fields that direct-SSH remote workspace snapshots actually project and manage.
 * Non-terminal fields (such as `openFilesByWorktree` editor drafts) are never reported by an
 * SSH host snapshot, so host testimony does not supersede them and they are never withheld.
 */
const SSH_TERMINAL_TESTIMONY_FIELDS: ReadonlySet<keyof WorkspaceSessionState> = new Set([
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'remoteSessionIdsByTabId',
  'localOnlyScrollbackByTabId',
  'terminalPtyIncarnationsByPaneKey',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'defaultTerminalTabsAppliedByWorktreeId',
  'activeTabIdByWorktree',
  'activeTabTypeByWorktree'
])
/**
 * The shadow minus every parked row whose host has already answered for it. Returns the input by
 * reference when nothing is withheld.
 */
export function shadowRowsTheHostHasNotAnswered(
  shadow: HostSessionSlices | undefined,
  state: RemoteWorkspaceTestimonyState
): HostSessionSlices | undefined {
  if (!shadow) {
    return shadow
  }

  let withheld = false
  const nextShadow: HostSessionSlices = {}

  for (const [hostId, hostSlice] of Object.entries(shadow) as [
    ExecutionHostId,
    WorkspaceSessionState | undefined
  ][]) {
    if (!hostSlice) {
      nextShadow[hostId] = hostSlice
      continue
    }

    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind !== 'ssh' || !hostHasAnsweredForTarget(state, parsed.targetId)) {
      nextShadow[hostId] = hostSlice
      continue
    }

    let hostWithheld = false
    let survivingParkableFieldCount = 0
    const nextHostSlice: WorkspaceSessionState = { ...hostSlice }
    const worktreeIdByTabIdInShadow = buildWorktreeIdByTabId(hostSlice)

    for (const field of PARKABLE_HOST_SESSION_FIELDS) {
      const record = hostSlice[field]
      if (!isWorkspaceSessionRecord(record)) {
        continue
      }

      const ownership = WORKSPACE_SESSION_FIELD_OWNERSHIP[field]
      let fieldWithheld = false
      const survivingRecord: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(record)) {
        const owningWorkspaceKey =
          ownership === 'worktreeKeyed'
            ? key
            : ownership === 'tabKeyed'
              ? worktreeIdByTabIdInShadow.get(key)
              : worktreeIdForPaneKey(worktreeIdByTabIdInShadow, key)
        const isFolder =
          owningWorkspaceKey !== undefined &&
          parseWorkspaceKey(owningWorkspaceKey)?.type === 'folder'
        const isCoveredByTerminalTestimony = SSH_TERMINAL_TESTIMONY_FIELDS.has(field)
        if (isFolder || !isCoveredByTerminalTestimony) {
          survivingRecord[key] = value
        } else {
          fieldWithheld = true
        }
      }

      if (fieldWithheld) {
        hostWithheld = true
        withheld = true
        if (Object.keys(survivingRecord).length > 0) {
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: field is a parkable record field and survivingRecord contains only its surviving entries.
          ;(nextHostSlice as Record<string, unknown>)[field] = survivingRecord
          survivingParkableFieldCount++
        } else {
          delete nextHostSlice[field]
        }
      } else {
        if (Object.keys(record).length > 0) {
          survivingParkableFieldCount++
        }
      }
    }

    if (hostWithheld) {
      if (survivingParkableFieldCount > 0) {
        nextShadow[hostId] = nextHostSlice
      }
    } else {
      nextShadow[hostId] = hostSlice
    }
  }

  return withheld ? nextShadow : shadow
}
