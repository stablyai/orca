import type { PreloadApi } from '../../../../preload/api-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../../shared/workspace-session-state-types'
import { sanitizeWebRuntimeWorkspaceSession } from '../web-workspace-session'
import { readLocalWebUIState } from './web-preferences-store'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'
import { SESSION_STORAGE_KEY, readJson, writeJson } from './web-storage'
import { createWebEditorRecoveryApi } from './web-editor-recovery-api'

export function sessionStorageKeyForHost(hostId?: string | null): string {
  const resolved = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  return resolved === LOCAL_EXECUTION_HOST_ID
    ? SESSION_STORAGE_KEY
    : `${SESSION_STORAGE_KEY}.${resolved}`
}

/** The web client's own partition census: the host-suffixed keys it has written. Boot reads these
 *  instead of inferring the set from the repo catalog, which cannot name a target whose only
 *  workspace is a folder. */
export function listStoredWorkspaceSessionHostIds(): ExecutionHostId[] {
  const hostIds = new Set<ExecutionHostId>([LOCAL_EXECUTION_HOST_ID])
  const prefix = `${SESSION_STORAGE_KEY}.`
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index)
    if (!key?.startsWith(prefix)) {
      continue
    }
    const hostId = normalizeExecutionHostId(key.slice(prefix.length))
    if (hostId) {
      hostIds.add(hostId)
    }
  }
  return [...hostIds]
}

export function getStoredWorkspaceSession(hostId?: string | null): WorkspaceSessionState {
  const resolvedHostId = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  if (resolvedHostId !== LOCAL_EXECUTION_HOST_ID) {
    return sanitizeWebRuntimeWorkspaceSession(
      readJson(sessionStorageKeyForHost(resolvedHostId), getDefaultWorkspaceSession())
    )
  }
  const localSession = sanitizeWebRuntimeWorkspaceSession(
    readJson(SESSION_STORAGE_KEY, getDefaultWorkspaceSession())
  )
  if (!requireActiveEnvironmentOrNull()) {
    return localSession
  }
  const ui = readLocalWebUIState()
  // Why: replaying browser-local terminal handles first creates stale remote PTYs; mirror host session-tabs instead.
  return sanitizeWebRuntimeWorkspaceSession({
    ...getDefaultWorkspaceSession(),
    activeRepoId: ui.lastActiveRepoId,
    activeWorktreeId: ui.lastActiveWorktreeId,
    lastVisitedAtByWorktreeId: localSession.lastVisitedAtByWorktreeId
  })
}

export function createWebWorkspaceSessionApi(): Partial<PreloadApi> {
  const recovery = createWebEditorRecoveryApi(() =>
    listStoredWorkspaceSessionHostIds().map((hostId) => ({
      hostId,
      session: sanitizeWebRuntimeWorkspaceSession(
        readJson(sessionStorageKeyForHost(hostId), getDefaultWorkspaceSession())
      )
    }))
  )
  return {
    session: {
      recovery: recovery.api,
      // Mirrors desktop bridge: non-local hosts persist under a host-suffixed key so their sessions stay isolated from local.
      get: async (hostId) => {
        const session = getStoredWorkspaceSession(hostId)
        try {
          return await recovery.restoreSession(session, hostId)
        } catch (error) {
          console.error('[editor-recovery] Could not restore browser drafts:', error)
          return session
        }
      },
      listHostIds: () => Promise.resolve(listStoredWorkspaceSessionHostIds()),
      set: async (session, hostId) => {
        writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session))
      },
      patch: async (patch: WorkspaceSessionPatch, hostId) => {
        writeJson(
          sessionStorageKeyForHost(hostId),
          sanitizeWebRuntimeWorkspaceSession({
            ...getStoredWorkspaceSession(hostId),
            ...patch
          })
        )
      },
      // Why a no-op: web closes reach the host through its session-tab and terminal close RPCs.
      closeTerminalSurface: async () => {},
      // localStorage writes synchronously, so there is no deferred web flush.
      flush: async () => {},
      readTerminalScrollback: () => null,
      setSync: (session, hostId) => {
        writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session))
      }
    }
  }
}
