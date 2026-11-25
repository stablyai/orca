import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type {
  GiteaConnectionStatus,
  GiteaIssueUpdate,
  GiteaMutationResult
} from '../../../../../shared/gitea/gitea-types'
import type { TaskSourceContext } from '../../../../../shared/work-items/task-source-context'
import { giteaApiFor } from '@/runtime/repository-gitea/gitea-owner-api'

// Repo calls go to the host that owns the repo. Server connections belong to this client's own
// runtime (the desktop, or the server a web client is paired to), so a host switch never stales them.

export type GiteaIssueScope = {
  repoPath: string
  repoId?: string | null
  sourceContext?: TaskSourceContext | null
  /** The repo's own host, from its row. */
  repoOwnerExecutionHostId?: string
}

export type GiteaSlice = {
  giteaStatus: GiteaConnectionStatus | null
  giteaStatusLoaded: boolean
  refreshGiteaStatus: () => Promise<GiteaConnectionStatus | null>
  giteaConnect: (args: {
    baseUrl: string
    token: string
  }) => Promise<{ ok: boolean; error?: string }>
  giteaDisconnect: (serverId?: string) => Promise<void>
  giteaTestConnection: (serverId?: string) => Promise<{ ok: boolean; error?: string }>
  createGiteaIssue: (
    scope: GiteaIssueScope,
    input: { title: string; body?: string; assignees?: string[]; labelIds?: number[] }
  ) => Promise<{ ok: true; number: number; url: string } | { ok: false; error: string }>
  updateGiteaIssue: (
    scope: GiteaIssueScope,
    issueNumber: number,
    updates: GiteaIssueUpdate
  ) => Promise<GiteaMutationResult>
}

function requestArgs(scope: GiteaIssueScope): GiteaIssueScope {
  return {
    repoPath: scope.repoPath,
    repoId: scope.repoId ?? null,
    sourceContext: scope.sourceContext ?? null,
    ...(scope.repoOwnerExecutionHostId
      ? { repoOwnerExecutionHostId: scope.repoOwnerExecutionHostId }
      : {})
  }
}

export const createGiteaSlice: StateCreator<AppState, [], [], GiteaSlice> = (set, get) => ({
  giteaStatus: null,
  giteaStatusLoaded: false,

  refreshGiteaStatus: async () => {
    try {
      const status = await window.api.gitea.status()
      set({ giteaStatus: status, giteaStatusLoaded: true })
      return status
    } catch {
      set({ giteaStatusLoaded: true })
      return get().giteaStatus
    }
  },

  giteaConnect: async (args) => {
    const result = await window.api.gitea.connect(args)
    if (result.ok) {
      await get().refreshGiteaStatus()
    }
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  },

  giteaDisconnect: async (serverId) => {
    await window.api.gitea.disconnect(serverId ? { serverId } : undefined)
    await get().refreshGiteaStatus()
  },

  giteaTestConnection: async (serverId) => {
    const result = await window.api.gitea.testConnection(serverId ? { serverId } : undefined)
    // A test can surface a per-server decrypt error, so refresh status alongside.
    await get().refreshGiteaStatus()
    return result.ok ? { ok: true } : { ok: false, error: result.error }
  },

  createGiteaIssue: async (scope, input) => {
    const result = await giteaApiFor(scope).createIssue({ ...requestArgs(scope), ...input })
    return result.ok
      ? { ok: true, number: result.number, url: result.url }
      : { ok: false, error: result.error }
  },

  updateGiteaIssue: async (scope, issueNumber, updates) =>
    giteaApiFor(scope).updateIssue({ ...requestArgs(scope), number: issueNumber, updates })
})
