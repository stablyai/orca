import { vi } from 'vitest'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { makeTab } from '@/store/terminals/testing/terminal-tab.test-fixture'
import { getRepoExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { applyWorkspaceSessionEntriesPatch } from '../../../../../shared/workspace-session/workspace-session-entries-patch'
import { applyDesktopRelayWrite } from '../../../../../shared/workspace-session/desktop-relay-ownership'
import { DESKTOP_RELAY_WRITE_VERSION } from '../../../../../shared/workspace-session/desktop-relay-write'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'
import { createSessionWriteSubscriber } from './session-write-subscriber'
import { AcknowledgedWorkspaceSessionEntries } from './workspace-session-acknowledged-entries'
import { patchWorkspaceSessionByHost, type SessionApi } from './workspace-session-host-persistence'
import { probeDesktopRelays } from './desktop-relay-writes'

export const DEBOUNCE_MS = 150
const SSH_REPO = { ...TEST_REPO, connectionId: 'conn-1' }
export const SSH_HOST = getRepoExecutionHostId(SSH_REPO)
export const WORKTREE_ID = `${SSH_REPO.id}::/remote/wt`

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an unwritten partition is empty; readers use only the fields they name.
const EMPTY_PARTITION = {} as WorkspaceSessionState

/** Main's partitions, written the way its session handlers apply a window's saves. */
export function inMemoryMain() {
  const partitions = new Map<string, WorkspaceSessionState>()
  const fenced = new Set<string>()
  // Each relay write main received: per host, the ids it carried.
  const sentHosts: {
    hostId: string
    relayIdsByTabId: Record<string, string>
    removedTabIds?: string[]
  }[][] = []
  const stored = (hostId: string) => partitions.get(hostId) ?? EMPTY_PARTITION
  const api: SessionApi = {
    get: async (hostId) => stored(hostId ?? 'local'),
    patch: async () => {
      throw new Error('this window sends entries')
    },
    patchEntries: async (args, hostId) => {
      const key = hostId ?? 'local'
      if (fenced.has(key)) {
        return { status: 'skipped' }
      }
      partitions.set(key, {
        ...stored(key),
        ...applyWorkspaceSessionEntriesPatch(stored(key), args)
      })
      return { status: 'applied' }
    },
    desktopRelaysVersion: async () => DESKTOP_RELAY_WRITE_VERSION,
    applyDesktopRelays: async ({ hosts }) => {
      sentHosts.push(
        hosts.map(({ hostId, relayIdsByTabId, removedTabIds }) => ({
          hostId,
          relayIdsByTabId,
          ...(removedTabIds?.length ? { removedTabIds } : {})
        }))
      )
      const result = { applied: [], unchanged: [], skipped: [], refused: [] } as Record<
        'applied' | 'unchanged' | 'skipped' | 'refused',
        string[]
      >
      for (const { hostId, ...write } of hosts) {
        if (fenced.has(hostId)) {
          result.skipped.push(hostId)
          continue
        }
        const { patch, refused } = applyDesktopRelayWrite(stored(hostId), write, null)
        if (refused) {
          result.refused.push(hostId)
        }
        if (patch) {
          partitions.set(hostId, { ...stored(hostId), ...patch })
        }
        result.applied.push(hostId)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: host ids came from the window's own write.
      return result as Awaited<ReturnType<NonNullable<SessionApi['applyDesktopRelays']>>>
    }
  }
  return { api, partitions, fenced, stored, sentHosts }
}

function sshState(status: 'connected' | 'disconnected') {
  return { targetId: 'conn-1', status, error: null, reconnectAttempt: 0 }
}

export async function windowSavingTo(main: ReturnType<typeof inMemoryMain>) {
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
    repos: [SSH_REPO],
    worktreesByRepo: {
      [SSH_REPO.id]: [makeWorktree({ id: WORKTREE_ID, repoId: SSH_REPO.id, path: '/remote/wt' })]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab({ id: 'tab-a', worktreeId: WORKTREE_ID, ptyId: 'relay-a' })]
    },
    ptyIdsByTabId: { 'tab-a': ['relay-a'] },
    sshConnectionStates: new Map([['conn-1', sshState('connected')]]),
    workspaceSessionReady: true,
    hydrationSucceeded: true
  })
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
  const endRelay = async () => {
    store.setState((state) => ({
      tabsByWorktree: {
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({ ...tab, ptyId: null }))
      },
      ptyIdsByTabId: {},
      sshConnectionStates: new Map([['conn-1', sshState('disconnected')]])
    }))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
  }
  const renameTab = async (title: string) => {
    store.setState((state) => ({
      tabsByWorktree: {
        [WORKTREE_ID]: state.tabsByWorktree[WORKTREE_ID]!.map((tab) => ({ ...tab, title }))
      }
    }))
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
  }
  return { store, stop, endRelay, renameTab }
}
