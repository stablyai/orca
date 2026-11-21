import { vi } from 'vitest'
import type { Repo } from '../../../../../shared/repository/repo-types'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { applyWorkspaceSessionEntriesPatch } from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import { applyDesktopRelayWrite } from '../../../../../shared/workspace-session/desktop-relay-ownership'
import {
  DESKTOP_RELAY_WRITE_VERSION,
  type DesktopRelayWrite,
  type DesktopRelayWriteResult
} from '../../../../../shared/workspace-session/desktop-relay-write'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { createSessionWriteSubscriber } from './session-write-subscriber'
import { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'
import {
  patchWorkspaceSessionByHost,
  persistWorkspaceSessionByHost,
  type SessionApi
} from './workspace-session-host-persistence'
import { buildWorkspaceSessionPayload } from './workspace-session'
import type { WorkspaceSessionApi } from '../../../../../preload/api/workspaces/workspace-session-api'
import { probeDesktopRelays } from './desktop-relay-writes'

export const DEBOUNCE_MS = 150
export const SSH_REPO: Repo = { ...TEST_REPO, connectionId: 'conn-1' }
export const SSH_HOST = getRepoExecutionHostId(SSH_REPO)
export const WORKTREE_ID = `${SSH_REPO.id}::/remote/wt`

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an unwritten partition is empty; readers use only the fields they name.
const EMPTY_PARTITION = {} as WorkspaceSessionState

/** Main's partitions, written the way its session handlers apply a window's saves. */
type Via = 'entries' | 'set' | 'separate'

export function inMemoryMain() {
  const partitions = new Map<string, WorkspaceSessionState>()
  const fenced = new Set<string>()
  // Each relay host main received, and whether it rode with that host's partition write.
  const sentHosts: {
    hostId: string
    relayIdsByTabId: Record<string, string>
    removedTabIds?: string[]
    via: Via
  }[][] = []
  const stored = (hostId: string) => partitions.get(hostId) ?? EMPTY_PARTITION
  const record = (via: Via, hosts: DesktopRelayWrite['hosts']) =>
    sentHosts.push(
      hosts.map(({ hostId, relayIdsByTabId, removedTabIds }) => ({
        hostId,
        relayIdsByTabId,
        ...(removedTabIds?.length ? { removedTabIds } : {}),
        via
      }))
    )
  const applyRelays = (hostId: string, write: DesktopRelayWrite['hosts'][number]) => {
    const { patch, refused } = applyDesktopRelayWrite(stored(hostId), write, null)
    if (patch) {
      partitions.set(hostId, { ...stored(hostId), ...patch })
    }
    return refused ? 'refused' : patch ? 'applied' : 'unchanged'
  }
  const api: SessionApi & Pick<WorkspaceSessionApi['session'], 'set' | 'flush'> = {
    get: async (hostId) => stored(hostId ?? 'local'),
    set: async (session, hostId, options) => {
      const key = hostId ?? 'local'
      if (fenced.has(key)) {
        return { status: 'skipped' }
      }
      const { remoteSessionIdsByTabId, desktopRelayOwnerByTabId } = stored(key)
      partitions.set(
        key,
        options?.relays === 'separate'
          ? { ...session, remoteSessionIdsByTabId, desktopRelayOwnerByTabId }
          : session
      )
      if (!options?.carried) {
        return { status: 'applied' }
      }
      record('set', [options.carried])
      const relays = applyRelays(key, options.carried)
      return { status: 'applied', relays }
    },
    flush: async () => {},
    patch: async () => {
      throw new Error('this window sends entries')
    },
    patchEntries: async (args, hostId, relays) => {
      const key = hostId ?? 'local'
      if (fenced.has(key)) {
        return { status: 'skipped' }
      }
      partitions.set(key, {
        ...stored(key),
        ...applyWorkspaceSessionEntriesPatch(stored(key), args)
      })
      if (!relays) {
        return { status: 'applied' }
      }
      record('entries', [relays])
      return { status: 'applied', relays: applyRelays(key, relays) }
    },
    desktopRelaysVersion: async () => DESKTOP_RELAY_WRITE_VERSION,
    applyDesktopRelays: async ({ hosts }) => {
      record('separate', hosts)
      const result: DesktopRelayWriteResult = {
        applied: [],
        unchanged: [],
        skipped: [],
        refused: []
      }
      for (const host of hosts) {
        if (fenced.has(host.hostId)) {
          result.skipped.push(host.hostId)
          continue
        }
        const status = applyRelays(host.hostId, host)
        result[status === 'refused' ? 'applied' : status].push(host.hostId)
        if (status === 'refused') {
          result.refused.push(host.hostId)
        }
      }
      return result
    }
  }
  return { api, partitions, fenced, stored, sentHosts }
}

const PARKED_PARTITION: WorkspaceSessionState = {
  ...EMPTY_PARTITION,
  tabsByWorktree: { 'other::/p': [makeTab({ id: 'tab-p', worktreeId: 'other::/p' })] }
}

function sshState(status: 'connected' | 'disconnected') {
  return { targetId: 'conn-1', status, error: null, reconnectAttempt: 0 }
}

export async function windowSavingTo(
  main: ReturnType<typeof inMemoryMain>,
  {
    listed = true,
    repo = SSH_REPO,
    parked = false,
    secondTab = false
  }: { listed?: boolean; repo?: Repo; parked?: boolean; secondTab?: boolean } = {}
) {
  probeDesktopRelays(main.api)
  await vi.advanceTimersByTimeAsync(0)
  const store = createTestStore()
  const acknowledged = new AcknowledgedWorkspaceSessionEntries()
  const stop = createSessionWriteSubscriber({
    store,
    debounceMs: DEBOUNCE_MS,
    persist: ({ patch }) =>
      patchWorkspaceSessionByHost(main.api, patch, store.getState(), acknowledged).written
  })
  seedStore(store, {
    repos: [repo],
    // Unlisted: a cold start before the SSH host's worktree listing arrives.
    worktreesByRepo: listed
      ? {
          [SSH_REPO.id]: [
            makeWorktree({ id: WORKTREE_ID, repoId: SSH_REPO.id, path: '/remote/wt' })
          ]
        }
      : {},
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTab({ id: 'tab-a', worktreeId: WORKTREE_ID, ptyId: 'relay-a' }),
        ...(secondTab ? [makeTab({ id: 'tab-b', worktreeId: WORKTREE_ID, ptyId: 'relay-b' })] : [])
      ]
    },
    ptyIdsByTabId: { 'tab-a': ['relay-a'], ...(secondTab ? { 'tab-b': ['relay-b'] } : {}) },
    sshConnectionStates: new Map([['conn-1', sshState('connected')]]),
    // Parked: the SSH partition also holds another host's workspace, so the window can't speak for it in full.
    ...(parked
      ? {
          contestedHostWorkspaceSessions: { [SSH_HOST]: PARKED_PARTITION }
        }
      : {}),
    workspaceSessionReady: true,
    hydrationSucceeded: true
  })
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
  // One tab's relay, or (no tab) every relay as the connection drops.
  const dropRelay = (tabId?: string) =>
    store.setState((state) => ({
      tabsByWorktree: {
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID]!.map((tab) =>
          !tabId || tab.id === tabId ? { ...tab, ptyId: null } : tab
        )
      },
      ptyIdsByTabId: tabId
        ? Object.fromEntries(Object.entries(state.ptyIdsByTabId).filter(([id]) => id !== tabId))
        : {},
      ...(tabId ? {} : { sshConnectionStates: new Map([['conn-1', sshState('disconnected')]]) })
    }))
  const endRelay = async (tabId?: string) => {
    dropRelay(tabId)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
  }
  // A durable full save (a requested tab close) before the debounced save runs.
  const durableSave = () =>
    persistWorkspaceSessionByHost(
      main.api,
      buildWorkspaceSessionPayload(store.getState()),
      store.getState()
    )
  const renameTab = async (title: string) => {
    store.setState((state) => ({
      tabsByWorktree: {
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({ ...tab, title }))
      }
    }))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
  }
  return { store, stop, endRelay, dropRelay, durableSave, renameTab }
}
