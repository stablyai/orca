// Lifecycle actions on an Orca Cloud workspace (restart, archive, unarchive) as store updates:
// each marks the workspace pending while it runs and re-reads its status after.
import { noteCloudArchiveChanged } from './cloud-archive-changes'
import { translate } from '@/i18n/i18n'
import type { CloudWorkspaceResult } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedArchivePullRequest } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  cloudWorkspaceApi,
  cloudWorkspaceTarget,
  dismissCloudOom,
  getCloudWorkspaceSnapshot,
  noteCloudWakeProgress,
  refreshCloudWorkspaceStatus,
  updateCloudWorkspaceSnapshot
} from './orca-cloud-workspace-store'

/**
 * ARCHIVE-MENU-DISABLED: Unarchive's wake is settled by whoever wakes it next, but a workspace the
 * control plane already brought up starts no wake on open. A fresh read that says running settles
 * a still-pending unarchive wake, so the row is not left "waking" (Archive disabled, then stalled).
 */
async function settleUnarchiveWakeIfRunning(workspaceId: string): Promise<void> {
  const wake = getCloudWorkspaceSnapshot().wake[workspaceId]
  if (
    !wake ||
    wake.source !== 'unarchive' ||
    (wake.phase !== 'waking' && wake.phase !== 'connecting')
  ) {
    return
  }
  await refreshCloudWorkspaceStatus(workspaceId)
  const entry = getCloudWorkspaceSnapshot().status[workspaceId]
  const still = getCloudWorkspaceSnapshot().wake[workspaceId]
  if (still?.startedAt === wake.startedAt && !entry?.error && entry?.status?.state === 'ready') {
    noteCloudWakeProgress({ ...still, phase: 'ready', at: Date.now() })
  }
}

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

function unavailable(): CloudWorkspaceResult<never> {
  return {
    ok: false,
    code: 'not_cloud',
    message: translate(
      'auto.lib.orcaCloud.workspaceActions.unavailable',
      'Orca Cloud is unavailable.'
    )
  }
}

export function restartCloudWorkspace(workspaceId: string): Promise<CloudWorkspaceResult<null>> {
  const bridge = cloudWorkspaceApi()
  if (!bridge) {
    return Promise.resolve(unavailable())
  }
  return withPending(workspaceId, 'restart', async () => {
    const result = await bridge.restart(cloudWorkspaceTarget(workspaceId))
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
    /** The ordinary Sleep; a result whose workspaces did not all sleep stops the archive. */
    sleep: (workspaceId: string) => Promise<readonly { completed: boolean }[] | void>
    pullRequests?: HostedArchivePullRequest[]
  }
): Promise<CloudWorkspaceResult<null>> {
  const bridge = cloudWorkspaceApi()
  if (!bridge) {
    return Promise.resolve(unavailable())
  }
  return withPending(workspaceId, 'archive', async () => {
    const slept = await deps.sleep(workspaceId)
    if (slept && !slept.every((result) => result.completed)) {
      // Never archive a sandbox that is still running: it would keep using hours behind an "Archived" label.
      const message = translate(
        'auto.lib.orcaCloud.workspaceActions.archiveSleepFailed',
        'It’s still running. Your files are safe.'
      )
      return { ok: false, code: 'failed', message, userMessage: message }
    }
    const archived = await bridge.archive({
      ...cloudWorkspaceTarget(workspaceId),
      ...(deps.pullRequests?.length ? { pullRequests: deps.pullRequests } : {})
    })
    if (archived.ok) {
      noteCloudArchiveChanged()
    }
    return archived
  })
}

/** Unarchive resumes the disk on the control plane; `wake` then runs the ordinary open-and-wake path. */
export function unarchiveCloudWorkspace(
  workspaceId: string,
  deps: { wake: (workspaceId: string) => Promise<unknown> }
): Promise<CloudWorkspaceResult<null>> {
  const bridge = cloudWorkspaceApi()
  if (!bridge) {
    return Promise.resolve(unavailable())
  }
  return withPending(workspaceId, 'unarchive', async () => {
    const result = await bridge.unarchive(cloudWorkspaceTarget(workspaceId))
    if (result.ok) {
      noteCloudArchiveChanged()
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
      await settleUnarchiveWakeIfRunning(workspaceId)
    }
    return result
  })
}
