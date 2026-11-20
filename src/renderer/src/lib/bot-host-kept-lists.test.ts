// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  environment,
  status
} from '@/components/sidebar/worktree-list/listing/host-status-test-fixtures'
import type { Bot } from '../../../shared/bot-types'
import type { BotGroup } from '../../../shared/bots/bot-group'
import type { ExecutionHostId } from '../../../shared/execution-host/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { RuntimeEnvironmentStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { BotHostListingInput } from './bot-host-listing'

type PendingCall = { resolve: (value: unknown) => void }
const calls = vi.hoisted((): { pending: PendingCall[] } => ({ pending: [] }))

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: () => new Promise((resolve) => calls.pending.push({ resolve }))
}))

const CONNECTED: RuntimeEnvironmentStatus = {
  status: { ...status('runtime'), capabilities: ['bots.mobile.v1'] },
  checkedAt: 1
}
const DISCONNECTED: RuntimeEnvironmentStatus = { status: null, checkedAt: 1 }
const ANSWER = { threadReplies: false, webhooks: undefined }

function bot(id: string): Bot {
  return {
    id,
    name: id,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function group(id: string): BotGroup {
  return {
    id,
    name: id,
    hostId: 'local',
    revision: 1,
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    createdAt: 1,
    members: [],
    replyMode: { kind: 'all' }
  }
}

function home(id: string): FolderWorkspace {
  return {
    id,
    projectGroupId: 'bots',
    name: id,
    folderPath: `/bots/${id}`,
    executionHostId: 'runtime:m4',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 0
  }
}

function state(
  m4: RuntimeEnvironmentStatus | null,
  options: { pairingRevision?: number; folderWorkspaces?: FolderWorkspace[] } = {}
): BotHostListingInput {
  return {
    runtimeEnvironments: m4
      ? [{ ...environment('m4'), pairingRevision: options.pairingRevision ?? 1 }]
      : [],
    runtimeStatusByEnvironmentId: new Map(m4 ? [['m4', m4]] : []),
    runtimeEnvironmentCatalogHydrated: true,
    folderWorkspaces: options.folderWorkspaces ?? []
  }
}

/** One app launch: fresh modules over the same storage, following a store as the app does. */
async function launch(initial: BotHostListingInput) {
  vi.resetModules()
  const listing = await import('./bot-host-listing')
  const snapshot = await import('./bot-catalog-snapshot')
  const groups = await import('./bot-group-catalog-snapshot')
  const homes = await import('./bot-host-kept-homes')
  const kept = await import('./bot-host-kept-lists')
  const refresh = await import('./bot-host-refresh')
  let current = initial
  const listeners = new Set<(next: BotHostListingInput, previous: BotHostListingInput) => void>()
  listing.installBotHostListing(
    {
      getState: () => current,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }
    },
    false
  )
  return {
    snapshot,
    groups,
    kept,
    refresh,
    set: (next: BotHostListingInput) => {
      const previous = current
      current = next
      listeners.forEach((listener) => listener(current, previous))
    },
    homeIds: () =>
      homes.withKeptBotHomes([], snapshot.readBotHostIds()).map((workspace) => workspace.id),
    botIds: () => snapshot.readBots().map((entry) => entry.id),
    settle: () => vi.advanceTimersByTime(kept.KEPT_BOT_LIST_FLUSH_MS)
  }
}

const M4: ExecutionHostId = 'runtime:m4'

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  calls.pending = []
})
afterEach(() => {
  vi.useRealTimers()
})

describe('kept paired-server bot lists', () => {
  it("lists an away server's bots, groups and homes after a restart, replaced on reconnect", async () => {
    const first = await launch(
      state(CONNECTED, { folderWorkspaces: [home('fw-triage'), home('fw-room')] })
    )
    first.snapshot.publishBots([bot('triage'), bot('deleted-while-away')], ANSWER, M4)
    first.groups.publishBotGroups([group('room')], M4)
    first.settle()

    const away = await launch(state(DISCONNECTED))
    expect(away.snapshot.readBotHostState(M4)).toBe('offline')
    expect(away.botIds()).toEqual(['triage', 'deleted-while-away'])
    expect(away.groups.readBotGroups().map((entry) => entry.id)).toEqual(['room'])
    expect(away.homeIds()).toEqual(['fw-triage', 'fw-room'])

    away.set(state(CONNECTED))
    const read = away.refresh.refreshBotHost(M4)
    await vi.waitFor(() => expect(calls.pending.length).toBeGreaterThan(0))
    calls.pending[0].resolve({ bots: [bot('triage')] })
    await read
    expect(away.botIds()).toEqual(['triage'])
    away.settle()
    expect((await launch(state(DISCONNECTED))).botIds()).toEqual(['triage'])
  })

  it("never lets a kept list say a missing bot is gone; only this session's read does", async () => {
    const first = await launch(state(CONNECTED))
    first.snapshot.publishBots([bot('triage')], ANSWER, M4)
    first.settle()
    const restarted = await launch(state(CONNECTED))
    expect(restarted.botIds()).toEqual(['triage'])
    expect(restarted.snapshot.readBotHostListed(M4)).toBe(false)
  })

  it('forgets a server once it is unpaired, or re-paired to another server under the same id', async () => {
    const first = await launch(state(CONNECTED))
    first.snapshot.publishBots([bot('triage')], ANSWER, M4)
    first.settle()
    expect((await launch(state(DISCONNECTED, { pairingRevision: 2 }))).botIds()).toEqual([])

    const again = await launch(state(CONNECTED))
    again.snapshot.publishBots([bot('triage')], ANSWER, M4)
    again.settle()
    again.set(state(null))
    expect((await launch(state(DISCONNECTED))).botIds()).toEqual([])
  })
})
