import type { PreloadApi } from '../../../../preload/api-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId
} from '../../../../shared/execution-host'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../../shared/workspace-session-state-types'
import { sanitizeWebRuntimeWorkspaceSession } from '../web-workspace-session'
import { readLocalWebUIState } from './web-preferences-store'
import { requireActiveEnvironmentOrNull } from './web-runtime-session'
import { SESSION_STORAGE_KEY, readJson, writeJson } from './web-storage'

function sanitizeSession(session: WorkspaceSessionState): WorkspaceSessionState {
  return sanitizeWebRuntimeWorkspaceSession(session, !!window.orcaWorkspaceWindowNative)
}

export function sessionStorageKeyForHost(hostId?: string | null): string {
  const resolved = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  return resolved === LOCAL_EXECUTION_HOST_ID
    ? SESSION_STORAGE_KEY
    : `${SESSION_STORAGE_KEY}.${resolved}`
}

export function getStoredWorkspaceSession(hostId?: string | null): WorkspaceSessionState {
  const resolvedHostId = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  if (resolvedHostId !== LOCAL_EXECUTION_HOST_ID) {
    return sanitizeSession(
      readJson(sessionStorageKeyForHost(resolvedHostId), getDefaultWorkspaceSession())
    )
  }
  const localSession = sanitizeSession(readJson(SESSION_STORAGE_KEY, getDefaultWorkspaceSession()))
  if (!requireActiveEnvironmentOrNull()) {
    return localSession
  }
  const ui = readLocalWebUIState()
  // Why: replaying browser-local terminal handles first creates stale remote PTYs; mirror host session-tabs instead.
  return sanitizeSession({
    ...localSession,
    activeRepoId: ui.lastActiveRepoId,
    activeWorktreeId: ui.lastActiveWorktreeId,
    lastVisitedAtByWorktreeId: localSession.lastVisitedAtByWorktreeId
  })
}

export function createWebWorkspaceSessionApi(): Partial<PreloadApi> {
  return {
    session: {
      // Mirrors desktop bridge: non-local hosts persist under a host-suffixed key so their sessions stay isolated from local.
      get: (hostId) => Promise.resolve(getStoredWorkspaceSession(hostId)),
      set: async (session, hostId) => {
        writeJson(sessionStorageKeyForHost(hostId), sanitizeSession(session))
      },
      patch: async (patch: WorkspaceSessionPatch, hostId) => {
        writeJson(
          sessionStorageKeyForHost(hostId),
          sanitizeSession({
            ...getStoredWorkspaceSession(hostId),
            ...patch
          })
        )
      },
      flush: () =>
        window.orcaWorkspaceWindowNative?.presentationStorage?.flush() ?? Promise.resolve(),
      readTerminalScrollback: () => null,
      setSync: (session, hostId) => {
        writeJson(sessionStorageKeyForHost(hostId), sanitizeSession(session))
      }
    }
  }
}
