// PARITY-FOLLOW: one shared read of the team's cloud workspaces (with live presence) for the
// surfaces that show who is where: the sidebar's Team list and the top bar's people. Mounted
// surfaces share one poller per account, so several of them cost one request per beat.
import { useEffect, useSyncExternalStore } from 'react'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-activity/window-visibility-timeout-poller'
import { rememberCloudWorkspaces } from './cloud-workspace-identity'
import { cloudWorkspacesAvailable } from './use-cloud-workspaces'

/** Presence lives 45 s on the server; a read every 15 s keeps "here now" honest at low cost. */
export const TEAM_LIVE_POLL_MS = 15_000

type Snapshot = { account: string; workspaces: readonly CloudWorkspace[] } | null

let snapshot: Snapshot = null
const listeners = new Set<() => void>()
let running: { account: string; consumers: number; stop: () => void } | null = null

function publish(next: Snapshot): void {
  snapshot = next
  listeners.forEach((listener) => listener())
}

function start(account: string): () => void {
  let stopped = false
  const load = async (): Promise<void> => {
    if (!(await cloudWorkspacesAvailable())) {
      stopped = true
      return
    }
    const result = await window.api.cloudWorkspaces
      .list({ scope: 'team', archived: 'exclude' })
      .catch(() => null)
    if (stopped || running?.account !== account) {
      return
    }
    if (result?.ok) {
      rememberCloudWorkspaces(result.value)
      publish({ account, workspaces: result.value })
    } else if (result && !result.ok && result.error === 'not_configured') {
      stopped = true
    }
    // Any other failure keeps the last good read: presence fades on the next good one.
  }
  const stopPolling = installWindowVisibilityTimeoutPoller({
    run: load,
    getDelayMs: () => (stopped ? null : TEAM_LIVE_POLL_MS)
  })
  return () => {
    stopped = true
    stopPolling()
  }
}

function acquire(account: string): () => void {
  if (running && running.account !== account) {
    running.stop()
    running = null
    publish(null)
  }
  if (!running) {
    running = { account, consumers: 0, stop: start(account) }
  }
  running.consumers += 1
  const held = running
  return () => {
    held.consumers -= 1
    if (held.consumers === 0 && running === held) {
      held.stop()
      running = null
    }
  }
}

/**
 * The team's live (unarchived) cloud workspaces for this account, or null until the first read.
 * `account` null (signed out, not on a team) reads nothing.
 */
export function useTeamWorkspacesLive(account: string | null): readonly CloudWorkspace[] | null {
  useEffect(() => (account ? acquire(account) : undefined), [account])
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (account && snapshot?.account === account ? snapshot.workspaces : null)
  )
}

/** A local edit (a follow) shown at once, until the next read confirms it. */
export function patchTeamWorkspaceLive(id: string, patch: Partial<CloudWorkspace>): void {
  if (snapshot) {
    publish({
      ...snapshot,
      workspaces: snapshot.workspaces.map((w) => (w.id === id ? { ...w, ...patch } : w))
    })
  }
}

/**
 * Follow or unfollow (PARITY-FOLLOW). The live list updates from the server's answer; a refusal
 * leaves it as it was and resolves false (the caller says so).
 */
export async function setCloudWorkspaceFollow(id: string, follow: boolean): Promise<boolean> {
  const result = await window.api.cloudWorkspaces.follow(id, follow).catch(() => null)
  if (!result?.ok) {
    return false
  }
  patchTeamWorkspaceLive(id, {
    following: result.value.following,
    followers: result.value.followers
  })
  return true
}

/** Test and fixture seam: what the shared read last returned. */
export function setTeamWorkspacesLiveForTests(
  account: string | null,
  workspaces: readonly CloudWorkspace[] | null
): void {
  publish(account && workspaces ? { account, workspaces } : null)
}
