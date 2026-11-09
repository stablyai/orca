import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { resolveWorktreeRowOpenInRuntimeOwner } from '@/lib/workspace/ownership/worktree-row-open-in-owner'
import type { CloudSshStatus } from '../../../../../../shared/cloud-ssh'
import type { Worktree } from '../../../../../../shared/worktree/types'

export type CloudSshWorktree = Pick<Worktree, 'id' | 'hostId' | 'runtimeOwnerEnvironmentId'>

// Last answer per workspace, so a reopened menu renders its final layout at once.
const lastStatus = new Map<string, CloudSshStatus>()

/** Keeps a reopened menu right after an action changed this computer's access. */
export function noteCloudSshAccess(workspaceId: string, hasAccess: boolean): void {
  const status = lastStatus.get(workspaceId)
  if (status) {
    lastStatus.set(workspaceId, { ...status, hasAccess, asleep: hasAccess ? false : status.asleep })
  }
}

const NOT_CLOUD: CloudSshStatus = {
  cloud: false,
  hasAccess: false,
  asleep: false,
  alias: null,
  includeInstalled: false,
  editors: []
}

/** ~/.ssh/config is shared by every workspace's menu. */
export function noteCloudSshInclude(includeInstalled: boolean): void {
  for (const [id, status] of lastStatus) {
    lastStatus.set(id, { ...status, includeInstalled })
  }
}

export type CloudSshMenuState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'ready'; status: CloudSshStatus }

/** Whether a row's menu gets the Orca Cloud SSH items. Only a recipe VM's workspace can be one,
 *  decided from the store at once; whether it is Orca Cloud comes from main (cached per row). */
export function useCloudSshMenuState(worktree: CloudSshWorktree): CloudSshMenuState {
  const candidate = useAppStore((s) => {
    const environmentId = resolveWorktreeRowOpenInRuntimeOwner(s, worktree).runtimeEnvironmentId
    return environmentId
      ? s.runtimeEnvironments.some(
          (environment) => environment.id === environmentId && environment.source === 'ephemeral-vm'
        )
      : false
  })
  const [fetched, setFetched] = useState<{ workspaceId: string; status: CloudSshStatus } | null>(
    null
  )
  useEffect(() => {
    if (!candidate) {
      return
    }
    let live = true
    const workspaceId = worktree.id
    window.api.ephemeralVm
      .cloudSshStatus({ workspaceId })
      .then((status) => {
        lastStatus.set(workspaceId, status)
        if (live) {
          setFetched({ workspaceId, status })
        }
      })
      .catch((error: unknown) => {
        // Fall back to the ordinary menu rather than an SSH row that never enables.
        console.warn('[cloud-ssh] status failed', error)
        if (live) {
          setFetched({ workspaceId, status: NOT_CLOUD })
        }
      })
    return () => {
      live = false
    }
  }, [candidate, worktree.id])
  if (!candidate) {
    return { kind: 'none' }
  }
  const status = fetched?.workspaceId === worktree.id ? fetched.status : lastStatus.get(worktree.id)
  if (!status) {
    return { kind: 'loading' }
  }
  return status.cloud ? { kind: 'ready', status } : { kind: 'none' }
}
