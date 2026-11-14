// Tell each paired host which of its workspaces hold this window's unsaved edits, so its cleanup keeps them.
import { useEffect } from 'react'
import { errorMessage } from '../../../../shared/error-message'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import { createNonSecureContextUuid } from '../../../../shared/non-secure-context-uuid'
import { getRuntimeTargetForFileOwner } from '@/lib/files/access/file-owner-runtime-target'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { onServerControlConnected } from '../workspace-layout/server/server-layout-view-report'
import { subscribeRuntimeHostContactRegained } from '../hosts/connections/runtime-host-contact-regained'

function unsavedWorktreeIdsByEnvironment(state: AppState): Map<string, string[]> {
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
        sync(useAppStore.getState())
      })
  }

  const sync = (state: AppState): void => {
    const current = unsavedWorktreeIdsByEnvironment(state)
    for (const environmentId of new Set([...sent.keys(), ...current.keys()])) {
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

  const watch = (environmentId: string): void => {
    if (stopWatches.has(environmentId)) {
      return
    }
    const resend = (): void => {
      // A new socket, or an upgraded host that now has the method.
      // Unknown, not absent: an empty list must still go out to clear what the host holds.
      sent.set(environmentId, UNKNOWN)
      unsupported.delete(environmentId)
      sync(useAppStore.getState())
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
  const noteEnvironments = (
    state: Pick<AppState, 'runtimeStatusByEnvironmentId' | 'runtimeEnvironments'>
  ): void => {
    // Statuses can outlive a removed host; only configured hosts get a report.
    const configured = new Set(state.runtimeEnvironments.map((environment) => environment.id))
    for (const environmentId of state.runtimeStatusByEnvironmentId.keys()) {
      if (configured.has(environmentId) && !known.has(environmentId)) {
        known.add(environmentId)
        sent.set(environmentId, UNKNOWN)
      }
    }
  }
  noteEnvironments(useAppStore.getState())
  sync(useAppStore.getState())
  const stopStore = useAppStore.subscribe((state, previous) => {
    const environmentsChanged =
      state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId ||
      state.runtimeEnvironments !== previous.runtimeEnvironments
    if (environmentsChanged) {
      noteEnvironments(state)
    }
    if (
      environmentsChanged ||
      state.openFiles !== previous.openFiles ||
      state.editorDrafts !== previous.editorDrafts ||
      state.repos !== previous.repos ||
      selectWorktreesByRepo(state) !== selectWorktreesByRepo(previous)
    ) {
      sync(state)
    }
  })
  return () => {
    stopStore()
    for (const stop of stopWatches.values()) {
      stop()
    }
  }
}

export function useRemoteUnsavedEditorReport(): void {
  useEffect(() => installRemoteUnsavedEditorReport(), [])
}
