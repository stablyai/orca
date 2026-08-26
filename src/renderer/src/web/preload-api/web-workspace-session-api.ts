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

export function sessionStorageKeyForHost(hostId?: string | null): string {
  const resolved = normalizeExecutionHostId(hostId) ?? LOCAL_EXECUTION_HOST_ID
  return resolved === LOCAL_EXECUTION_HOST_ID
    ? SESSION_STORAGE_KEY
    : `${SESSION_STORAGE_KEY}.${resolved}`
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
  return {
    session: {
      // Mirrors desktop bridge: non-local hosts persist under a host-suffixed key so their sessions stay isolated from local.
      get: (hostId) => Promise.resolve(getStoredWorkspaceSession(hostId)),
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
      // localStorage writes synchronously, so there is no deferred web flush.
      flush: async () => {},
      readTerminalScrollback: () => null,
      setSync: (session, hostId) => {
        writeJson(sessionStorageKeyForHost(hostId), sanitizeWebRuntimeWorkspaceSession(session))
      }
    }
  }
}
