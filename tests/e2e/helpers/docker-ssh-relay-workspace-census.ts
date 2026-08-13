/**
 * Everything Journey 6 requires counted before and after a settle interval:
 * remote processes, panes, tabs, durable bindings, leases, and session-cap slots.
 *
 * Each dimension is read from the place that owns it — the container for
 * processes and cap slots, the durable session for bindings, the profile state
 * file for leases, the renderer store for what the user can see — so no single
 * source can make the census agree with itself while the host disagrees.
 */
import type { Page } from '@stablyai/playwright-test'
import { readDurablePaneBindings } from './remote-pane-durable-session'
import { readSshRemotePtyLeases } from './ssh-remote-pty-lease-file'
import { readDockerSshdSessionCap } from './docker-ssh-relay-sshd-session-cap'
import { readDockerSshRelayRemotePtys } from './docker-ssh-relay-remote-ptys'
import type { DockerSshRelayTarget } from './docker-ssh-relay-target'

export type RemoteWorkspaceCensus = {
  /** `pid@startTicks pane=<paneKey>`; the start time keeps a recycled pid from passing. */
  remoteShells: string[]
  tabIds: string[]
  /** `tabId/leafId` for every pane the user can see. */
  paneIds: string[]
  /** `partition tabId/leafId=ptyId` across both durable partitions. */
  durableBindings: string[]
  /** `leafId=state`; lease PTY ids are relay-local and unstable, leaf identity is not. */
  leases: string[]
  /** Authenticated sshd connections, each capped at `MaxSessions` channels. */
  sshdConnectionCount: number
}

export type RemoteWorkspaceCensusScope = {
  target: DockerSshRelayTarget
  hostId: string
  worktreeId: string
  targetId: string
  stateFile: string
}

async function readVisiblePanes(
  page: Page,
  worktreeId: string
): Promise<{ tabIds: string[]; paneIds: string[] }> {
  return page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    type LayoutNode =
      | { type: 'leaf'; leafId: string }
      | { type: 'split'; first: LayoutNode; second: LayoutNode }
      | null
    const collectLeafIds = (node: LayoutNode): string[] => {
      if (!node) {
        return []
      }
      return node.type === 'leaf'
        ? [node.leafId]
        : [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
    }
    const tabs = state.tabsByWorktree[worktreeId] ?? []
    const paneIds = tabs.flatMap((tab) => {
      const leafIds = collectLeafIds(
        (state.terminalLayoutsByTabId[tab.id]?.root ?? null) as LayoutNode
      )
      // `root: null` is the implicit single-pane layout a fresh tab carries until
      // it is first split, so it still counts as one visible pane.
      return leafIds.length > 0
        ? leafIds.map((leafId) => `${tab.id}/${leafId}`)
        : [`${tab.id}/<root>`]
    })
    return { tabIds: tabs.map((tab) => tab.id).sort(), paneIds: paneIds.sort() }
  }, worktreeId)
}

export async function readRemoteWorkspaceCensus(
  page: Page,
  scope: RemoteWorkspaceCensusScope
): Promise<RemoteWorkspaceCensus> {
  const visible = await readVisiblePanes(page, scope.worktreeId)
  return {
    remoteShells: readDockerSshRelayRemotePtys(scope.target)
      .map((pty) => `${pty.pid}@${pty.startTicks} pane=${pty.paneKey ?? '-'}`)
      .sort(),
    tabIds: visible.tabIds,
    paneIds: visible.paneIds,
    durableBindings: await readDurablePaneBindings(page, scope.hostId, scope.worktreeId),
    leases: readSshRemotePtyLeases(scope.stateFile, scope.targetId)
      .map((lease) => `${lease.leafId ?? '-'}=${lease.state}`)
      .sort(),
    sshdConnectionCount: readDockerSshdSessionCap(scope.target).connectionPids.length
  }
}

/** The census minus the connection count, which a reconnect legitimately churns. */
export function bindingIdentityOf(
  census: RemoteWorkspaceCensus
): Omit<RemoteWorkspaceCensus, 'sshdConnectionCount'> {
  const { sshdConnectionCount: _slots, ...identity } = census
  return identity
}

export function describeRemoteWorkspaceCensus(census: RemoteWorkspaceCensus): string {
  return [
    `shells=[${census.remoteShells.join(' | ')}]`,
    `tabs=${census.tabIds.length}`,
    `panes=[${census.paneIds.join(' | ')}]`,
    `bindings=[${census.durableBindings.join(' | ')}]`,
    `leases=[${census.leases.join(' | ')}]`,
    `sshdConnections=${census.sshdConnectionCount}`
  ].join(' ')
}
