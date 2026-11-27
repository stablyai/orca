// Tell each host, this app's own included, which of its workspaces hold this window's unsaved edits, so its cleanup keeps them.
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
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import type { WorktreeOperationRouteState } from '@/lib/workspace/ownership/worktree-operation-route'
import { onServerControlConnected } from '../workspace-layout/server/server-layout-view-report'
import { subscribeRuntimeHostContactRegained } from '../hosts/connections/runtime-host-contact-regained'
import {
  type RuntimeStatuses,
  subscribeStoreWithStatuses,
  runtimeStatusSubscriptionsFor
} from '@/store/slices/runtime-status/views/runtime-status-subscriptions'

type UnsavedReportState = WorktreeOperationRouteState & Pick<AppState, 'openFiles' | 'editorDrafts'>

// This app's runtime; environment ids are UUIDs, so it can't collide with one.
const LOCAL_HOST = '\0local'

function hostTarget(host: string): RuntimeClientTarget {
  return host === LOCAL_HOST ? { kind: 'local' } : { kind: 'environment', environmentId: host }
}

type HostReport = { worktreeIds: string[]; signature?: string }
const NO_REPORT: HostReport = { worktreeIds: [], signature: '' }

// Built at the first compare that gets past the skip gates, then reused by send and the completion recheck.
function signatureOf(report: HostReport): string {
  report.signature ??= report.worktreeIds.join('\n')
  return report.signature
}

function unsavedWorktreeIdsByHost(
  state: UnsavedReportState,
  hasLocalRuntime: boolean
): Map<string, HostReport> {
  const byHost = new Map<string, Set<string>>()
  for (const file of state.openFiles) {
    // An empty id names no workspace, and the host would reject the whole list for it.
    if ((!file.isDirty && state.editorDrafts[file.id] === undefined) || !file.worktreeId) {
      continue
    }
    // Restored tabs may lack the owner stamp; resolve it from the workspace like file operations do.
    const target = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
    // The session keeps only edit-mode drafts, after a save delay; this app's cleanup sees diff buffers and fresh edits only here.
    const host =
      target?.kind === 'environment'
        ? target.environmentId
        : target?.kind === 'local' && hasLocalRuntime
          ? LOCAL_HOST
          : null
    if (host !== null) {
      const ids = byHost.get(host) ?? new Set<string>()
      ids.add(file.worktreeId)
      byHost.set(host, ids)
    }
  }
  const reports = new Map<string, HostReport>()
  for (const [host, ids] of byHost) {
    reports.set(host, { worktreeIds: [...ids].sort() })
  }
  return reports
}

// The report reads only which files have drafts; typing replaces the map but keeps its keys, so it keeps the token.
const draftKeysTokens = new WeakMap<Record<string, string>, object>()
let latest: { drafts: Record<string, string>; keyCount: number; token: object } | null = null
function selectDraftKeys(state: Pick<AppState, 'editorDrafts'>): object {
  const drafts = state.editorDrafts
  const known = draftKeysTokens.get(drafts)
  if (known) {
    return known
  }
  const keys = Object.keys(drafts)
  const previous = latest
  const token =
    previous &&
    keys.length === previous.keyCount &&
    keys.every((key) => Object.hasOwn(previous.drafts, key))
      ? previous.token
      : {}
  draftKeysTokens.set(drafts, token)
  latest = { drafts, keyCount: keys.length, token }
  return token
}

/** Every field the report and file-owner routing read; the mapped type fails to compile until a new one is listed. */
const REPORT_INPUTS: {
  [K in keyof UnsavedReportState]-?: (state: UnsavedReportState) => unknown
} = {
  activeWorkspaceExecutionHostId: (state) => state.activeWorkspaceExecutionHostId,
  activeWorktreeId: (state) => state.activeWorktreeId,
  detectedWorktreesByRepo: selectDetectedWorktreesByRepo,
  editorDrafts: selectDraftKeys,
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
export function installUnsavedEditorHostReport(): () => void {
  const reporterId = windowReporterId()
  // A web client's local target is its paired host, which already gets this window's report.
  const hasLocalRuntime = !isWebClientLocation()
  const sent = new Map<string, string>()
  const unsupported = new Set<string>()
  const stopWatches = new Map<string, () => void>()
  // One report in flight per host, so an older list can never land after a newer one.
  const inFlight = new Set<string>()
  // A remounted reporter takes over; a reply to this one must not start more reports.
  let disposed = false
  // Checked against the store at every read, so no send depends on store-listener order.
  let reportInputs: readonly unknown[] | null = null
  let reports = new Map<string, HostReport>()
  const currentReports = (): ReadonlyMap<string, HostReport> => {
    const state = useAppStore.getState()
    const inputs = readReportInputs.map((read) => read(state))
    if (reportInputs?.every((value, index) => value === inputs[index]) !== true) {
      reports = unsavedWorktreeIdsByHost(state, hasLocalRuntime)
      reportInputs = inputs
    }
    return reports
  }

  const send = (host: string, report: HostReport): void => {
    sent.set(host, signatureOf(report))
    inFlight.add(host)
    callRuntimeRpc(hostTarget(host), 'workspaceCleanup.reportUnsavedEditors', {
      worktreeIds: report.worktreeIds,
      reporterId
    })
      .catch((error: unknown) => {
        if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
          // A host from before automatic cleanup removes nothing on its own.
          unsupported.add(host)
          return
        }
        // Kept as sent so typing does not retry a host that is down; regaining contact sends it again.
        console.warn(
          '[workspace-cleanup] a host did not take the unsaved-editor report:',
          errorMessage(error)
        )
      })
      .finally(() => {
        inFlight.delete(host)
        // Edits made while it was in flight go out now, as the latest list only.
        if (!disposed) {
          syncHosts([host])
        }
      })
  }

  const syncHosts = (hosts: Iterable<string>): void => {
    const current = currentReports()
    for (const host of hosts) {
      const report = current.get(host) ?? NO_REPORT
      if (inFlight.has(host) || unsupported.has(host) || sent.get(host) === signatureOf(report)) {
        continue
      }
      watch(host)
      send(host, report)
    }
  }
  const sync = (): void => syncHosts(new Set([...sent.keys(), ...currentReports().keys()]))

  const watch = (environmentId: string): void => {
    // The local IPC route only drops a report with the document, whose replacement reports afresh.
    if (environmentId === LOCAL_HOST || stopWatches.has(environmentId)) {
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
  const hostStatuses = runtimeStatusSubscriptionsFor(useAppStore)
  const noteEnvironments = (
    state: Pick<AppState, 'runtimeEnvironments'>,
    statuses: RuntimeStatuses,
    environmentIds: Iterable<string> = statuses.keys()
  ): string[] => {
    // Statuses can outlive a removed host; only configured hosts get a report.
    const noted: string[] = []
    let configured: Set<string> | undefined
    for (const environmentId of environmentIds) {
      if (known.has(environmentId) || !statuses.has(environmentId)) {
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
  noteEnvironments(useAppStore.getState(), hostStatuses.readStatuses())
  sync()
  // Routing reads no host status, so a status write only owes a first report to a newly seen host.
  const stopStatuses = hostStatuses.subscribeStatusChanges((change) =>
    syncHosts(noteEnvironments(useAppStore.getState(), hostStatuses.readStatuses(), change.ids))
  )
  const stopStore = subscribeStoreWithStatuses(useAppStore, (state, previous, statuses) => {
    if (state.runtimeEnvironments !== previous.runtimeEnvironments) {
      noteEnvironments(state, statuses)
    }
    if (readReportInputs.some((read) => read(state) !== read(previous))) {
      sync()
    }
  })
  return () => {
    disposed = true
    stopStatuses()
    stopStore()
    for (const stop of stopWatches.values()) {
      stop()
    }
  }
}

export function useUnsavedEditorHostReport(): void {
  useEffect(() => installUnsavedEditorHostReport(), [])
}
