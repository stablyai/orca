// Lifecycle actions on an Orca Cloud workspace (restart, archive, unarchive) as store updates:
// each marks the workspace pending while it runs and re-reads its status after.
import type { CloudWorkspaceResult } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedArchivePullRequest } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  cloudWorkspaceApi,
  dismissCloudOom,
  refreshCloudWorkspaceStatus,
  updateCloudWorkspaceSnapshot
} from './orca-cloud-workspace-store'

function withPending<T>(
  workspaceId: string,
  kind: 'restart' | 'archive' | 'unarchive',
  work: () => Promise<T>
): Promise<T> {
  updateCloudWorkspaceSnapshot((s) => ({ pending: { ...s.pending, [workspaceId]: kind } }))
  return work().finally(() => {
    updateCloudWorkspaceSnapshot((s) => {
      const pending = { ...s.pending }
      delete pending[workspaceId]
      return { pending }
    })
    void refreshCloudWorkspaceStatus(workspaceId)
  })
}

const UNAVAILABLE = {
  ok: false,
  code: 'not_cloud',
  message: 'Orca Cloud is unavailable.'
} as const

export function restartCloudWorkspace(workspaceId: string): Promise<CloudWorkspaceResult<null>> {
  const bridge = cloudWorkspaceApi()
  if (!bridge) {
    return Promise.resolve(UNAVAILABLE)
  }
  return withPending(workspaceId, 'restart', async () => {
    const result = await bridge.restart({ workspaceId })
    if (result.ok) {
      dismissCloudOom(workspaceId)
    }
    return result
  })
}

/**
 * Archive = the ordinary Sleep (terminals and chats saved, VM stopped) and then archive with a
 * snapshot TTL. `sleep` is injected so this module does not pull the sidebar sleep flow into tests.
 */
export function archiveCloudWorkspace(
  workspaceId: string,
  deps: {
    sleep: (workspaceId: string) => Promise<unknown>
    pullRequests?: HostedArchivePullRequest[]
  }
): Promise<CloudWorkspaceResult<null>> {
  const bridge = cloudWorkspaceApi()
  if (!bridge) {
    return Promise.resolve(UNAVAILABLE)
  }
  return withPending(workspaceId, 'archive', async () => {
    await deps.sleep(workspaceId)
    return bridge.archive({
      workspaceId,
      ...(deps.pullRequests?.length ? { pullRequests: deps.pullRequests } : {})
    })
  })
}

/** Unarchive resumes the disk on the control plane; `wake` then runs the ordinary open-and-wake path. */
export function unarchiveCloudWorkspace(
  workspaceId: string,
  deps: { wake: (workspaceId: string) => Promise<unknown> }
): Promise<CloudWorkspaceResult<null>> {
  const bridge = cloudWorkspaceApi()
  if (!bridge) {
    return Promise.resolve(UNAVAILABLE)
  }
  return withPending(workspaceId, 'unarchive', async () => {
    const result = await bridge.unarchive({ workspaceId })
    if (result.ok) {
      // Mark it unarchived so the wake path's archive guard lets the wake through.
      updateCloudWorkspaceSnapshot((s) => {
        const entry = s.status[workspaceId]
        return entry?.status
          ? {
              status: {
                ...s.status,
                [workspaceId]: {
                  ...entry,
                  status: { ...entry.status, state: 'waking', archive: null },
                  fetchedAt: Date.now()
                }
              }
            }
          : {}
      })
      await deps.wake(workspaceId)
    }
    return result
  })
}
