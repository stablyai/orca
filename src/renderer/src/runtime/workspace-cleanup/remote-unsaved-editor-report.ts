// Tell each paired host which of its workspaces hold this window's unsaved edits, so its cleanup keeps them.
import { useEffect } from 'react'
import { errorMessage } from '../../../../shared/errors/error-message'
import { hasRuntimeRpcErrorCode } from '../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import { createNonSecureContextUuid } from '../../../../shared/identifiers/non-secure-context-uuid'
import { getRuntimeTargetForFileOwner } from '@/lib/files/access/file-owner-runtime-target'
import type { WorktreeOperationRouteState } from '@/lib/workspace/ownership/worktree-operation-route'
import { onServerControlConnected } from '../workspace-layout/server/server-layout-view-report'
import { subscribeRuntimeHostContactRegained } from '../hosts/connections/runtime-host-contact-regained'
import { runtimeStatusSubscriptionsFor } from '@/store/slices/runtime-status/views/runtime-status-subscriptions'

type UnsavedReportState = WorktreeOperationRouteState & Pick<AppState, 'openFiles' | 'editorDrafts'>

function unsavedWorktreeIdsByEnvironment(state: UnsavedReportState): Map<string, string[]> {
  const byEnvironment = new Map<string, Set<string>>()
  for (const file of state.openFiles) {
    if (!file.isDirty && state.editorDrafts[file.id] === undefined) {
      continue
    }
    // Restored tabs may lack the owner stamp; resolve it from the workspace like file operations do.
    const target = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
    if (target?.kind === 'environment') {
      const ids = byEnvironment.get(target.environmentId) ?? new Set<string>()
      ids.add(file.worktreeId)
      byEnvironment.set(target.environmentId, ids)
    }
  }
  return new Map([...byEnvironment].map(([environmentId, ids]) => [environmentId, [...ids].sort()]))
}

/** Every field the report and file-owner routing read; the mapped type fails to compile until a new one is listed. */
const REPORT_INPUTS: {
  [K in keyof UnsavedReportState]-?: (state: UnsavedReportState) => unknown
} = {
  activeWorkspaceExecutionHostId: (state) => state.activeWorkspaceExecutionHostId,
  activeWorktreeId: (state) => state.activeWorktreeId,
  detectedWorktreesByRepo: selectDetectedWorktreesByRepo,
  editorDrafts: (state) => state.editorDrafts,
  folderWorkspaces: selectFolderWorkspaces,
  openFiles: (state) => state.openFiles,
  projectGroups: (state) => state.projectGroups,
  removedRuntimeEnvironmentIds: (state) => state.removedRuntimeEnvironmentIds,
  repos: (state) => state.repos,
  restoredRuntimeHostIdByWorkspaceSessionKey: (state) =>
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
  runtimeEnvironmentCatalogHydrated: (state) => state.runtimeEnvironmentCatalogHydrated,
  runtimeEnvironments: (state) => state.runtimeEnvironments,
  settings: (state) => state.settings,
  worktreesByRepo: selectWorktreesByRepo
}
const readReportInputs = Object.values(REPORT_INPUTS)

const UNKNOWN = '\0unknown'
const REPORTER_ID_KEY = 'orca.workspaceCleanup.unsavedEditorReporterId'

// Windows share main's control socket; a per-window id keeps one window's report from replacing another's. Survives reload.
function windowReporterId(): string {
  try {
    const existing = window.sessionStorage.getItem(REPORTER_ID_KEY)
    if (existing) {
      return existing
    }
    const created = createNonSecureContextUuid()
    window.sessionStorage.setItem(REPORTER_ID_KEY, created)
    return created
  } catch {
    return createNonSecureContextUuid()
  }
}

/** Reports changes per host, and again whenever contact with it is regained: a host drops a closed socket's report. */
export function installRemoteUnsavedEditorReport(): () => void {
  const reporterId = windowReporterId()
  const sent = new Map<string, string>()
  const unsupported = new Set<string>()
  const stopWatches = new Map<string, () => void>()
  // One report in flight per host, so an older list can never land after a newer one.
  const inFlight = new Set<string>()
  // Checked against the store at every read, so no send depends on store-listener order.
  let reportInputs: readonly unknown[] | null = null
  let reports = new Map<string, string[]>()
  const currentReports = (): ReadonlyMap<string, string[]> => {
    const state = useAppStore.getState()
    const inputs = readReportInputs.map((read) => read(state))
    if (reportInputs?.every((value, index) => value === inputs[index]) !== true) {
      reports = unsavedWorktreeIdsByEnvironment(state)
      reportInputs = inputs
    }
    return reports
  }

  const send = (environmentId: string, worktreeIds: string[]): void => {
    sent.set(environmentId, worktreeIds.join('\n'))
    inFlight.add(environmentId)
    callRuntimeRpc(
      { kind: 'environment', environmentId },
      'workspaceCleanup.reportUnsavedEditors',
      { worktreeIds, reporterId }
    )
      .catch((error: unknown) => {
        if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
          // A host from before automatic cleanup removes nothing on its own.
          unsupported.add(environmentId)
          return
        }
        // Kept as sent so typing does not retry a host that is down; regaining contact sends it again.
        console.warn(
          '[workspace-cleanup] a host did not take the unsaved-editor report:',
          errorMessage(error)
        )
      })
      .finally(() => {
        inFlight.delete(environmentId)
        // Edits made while it was in flight go out now, as the latest list only.
        syncHosts([environmentId])
      })
  }

  const syncHosts = (environmentIds: Iterable<string>): void => {
    const current = currentReports()
    for (const environmentId of environmentIds) {
      const worktreeIds = current.get(environmentId) ?? []
      if (
        inFlight.has(environmentId) ||
        unsupported.has(environmentId) ||
        sent.get(environmentId) === worktreeIds.join('\n')
      ) {
        continue
      }
      watch(environmentId)
      send(environmentId, worktreeIds)
    }
  }
  const sync = (): void => syncHosts(new Set([...sent.keys(), ...currentReports().keys()]))

  const watch = (environmentId: string): void => {
    if (stopWatches.has(environmentId)) {
      return
    }
    const resend = (): void => {
      // A new socket, or an upgraded host that now has the method.
      // Unknown, not absent: an empty list must still go out to clear what the host holds.
      sent.set(environmentId, UNKNOWN)
      unsupported.delete(environmentId)
      syncHosts([environmentId])
    }
    // Desktop sees control-socket changes; web clients only see host contact come back.
    const stopSocket = onServerControlConnected(environmentId, resend)
    const stopContact = subscribeRuntimeHostContactRegained(environmentId, resend)
    stopWatches.set(environmentId, () => {
      stopSocket()
      stopContact()
    })
  }

  // A reloaded window must clear what its previous renderer reported over main's still-open socket.
  const known = new Set<string>()
  /** The hosts that just got their first report owed. */
  const noteEnvironments = (
    state: Pick<AppState, 'runtimeStatusByEnvironmentId' | 'runtimeEnvironments'>,
    environmentIds: Iterable<string> = state.runtimeStatusByEnvironmentId.keys()
  ): string[] => {
    // Statuses can outlive a removed host; only configured hosts get a report.
    const noted: string[] = []
    let configured: Set<string> | undefined
    for (const environmentId of environmentIds) {
      if (known.has(environmentId) || !state.runtimeStatusByEnvironmentId.has(environmentId)) {
        continue
      }
      configured ??= new Set(state.runtimeEnvironments.map((environment) => environment.id))
      if (configured.has(environmentId)) {
        known.add(environmentId)
        sent.set(environmentId, UNKNOWN)
        noted.push(environmentId)
      }
    }
    return noted
  }
  noteEnvironments(useAppStore.getState())
  sync()
  // Routing reads no host status, so a status write only owes a first report to a newly seen host.
  const stopStatuses = runtimeStatusSubscriptionsFor(useAppStore).subscribeStatusChanges((change) =>
    syncHosts(noteEnvironments(useAppStore.getState(), change.ids))
  )
  const stopStore = useAppStore.subscribe((state, previous) => {
    if (state.runtimeEnvironments !== previous.runtimeEnvironments) {
      noteEnvironments(state)
    }
    if (readReportInputs.some((read) => read(state) !== read(previous))) {
      sync()
    }
  })
  return () => {
    stopStatuses()
    stopStore()
    for (const stop of stopWatches.values()) {
      stop()
    }
  }
}

export function useRemoteUnsavedEditorReport(): void {
  useEffect(() => installRemoteUnsavedEditorReport(), [])
}
