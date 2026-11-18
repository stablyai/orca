// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  environment,
  status
} from '@/components/sidebar/worktree-list/listing/host-status-test-fixtures'
import type { Bot } from '../../../shared/bot-types'
import type { RuntimeEnvironmentStatus } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  publishBots,
  readBotHostIds,
  readBots,
  readUpdateNeededBotHosts,
  setBotHostListing
} from './bot-catalog-snapshot'
import { refreshBotHost } from './bot-host-refresh'
import { syncBotHostListing, type BotHostListingInput } from './bot-host-listing'
import { onBotsChanged } from './bots-changed-window-event'

type PendingCall = { target: unknown; resolve: (value: unknown) => void }
const calls = vi.hoisted((): { pending: PendingCall[] } => ({ pending: [] }))

// A call that never answers fails at its timeout, as the paired transport does.
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (
    target: unknown,
    _method: string,
    _params: unknown,
    options?: { timeoutMs?: number }
  ) =>
    new Promise((resolve, reject) => {
      calls.pending.push({ target, resolve })
      if (options?.timeoutMs !== undefined) {
        setTimeout(() => reject(new Error('timed out')), options.timeoutMs)
      }
    })
}))

const SERVES_BOTS = ['bots.mobile.v1']

function connected(capabilities: string[]): RuntimeEnvironmentStatus {
  return { status: { ...status('runtime'), capabilities }, checkedAt: 1 }
}

const DISCONNECTED: RuntimeEnvironmentStatus = { status: null, checkedAt: 1 }

function input(
  statuses: Record<string, RuntimeEnvironmentStatus | undefined>
): BotHostListingInput {
  return {
    runtimeEnvironments: Object.keys(statuses).map((id) => environment(id)),
    folderWorkspaces: [],
    runtimeEnvironmentCatalogHydrated: false,
    runtimeStatusByEnvironmentId: new Map(
      Object.entries(statuses).flatMap(([id, entry]) => (entry ? [[id, entry]] : []))
    )
  }
}

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

const ANSWER = { threadReplies: false, webhooks: undefined }

beforeEach(() => {
  calls.pending = []
  setBotHostListing({ hosts: [{ hostId: 'local', state: 'live' }], updateNeeded: [] })
})

describe('syncBotHostListing', () => {
  it('lists a connected server that serves bots, and asks an older one for an update', () => {
    syncBotHostListing(input({ m4: connected(SERVES_BOTS), linux: connected([]) }), false)
    expect(readBotHostIds()).toEqual(['local', 'runtime:m4'])
    expect(readUpdateNeededBotHosts()).toEqual(['runtime:linux'])
  })

  it("keeps a disconnected server's bots from the last read, and never lists one it never read", () => {
    syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), false)
    publishBots([bot('triage')], ANSWER, 'runtime:m4')
    syncBotHostListing(input({ m4: DISCONNECTED, linux: DISCONNECTED }), false)
    expect(readBotHostIds()).toEqual(['local', 'runtime:m4'])
    expect(readBots().map((entry) => [entry.hostId, entry.id])).toEqual([['runtime:m4', 'triage']])
  })

  it("drops a server's bots once it is unpaired", () => {
    syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), false)
    publishBots([bot('triage')], ANSWER, 'runtime:m4')
    syncBotHostListing(input({}), false)
    expect(readBotHostIds()).toEqual(['local'])
    expect(readBots()).toEqual([])
  })

  it('lists only its server in a paired web window, where this runtime is the server', () => {
    syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), true)
    expect(readBotHostIds()).toEqual(['runtime:m4'])
  })

  it('has every bot view re-read a server when it is first listed and when it comes back, only that one', () => {
    const changed: string[] = []
    const stop = onBotsChanged((hostId) => changed.push(hostId))
    syncBotHostListing(input({ m4: connected(SERVES_BOTS), linux: connected(SERVES_BOTS) }), false)
    syncBotHostListing(input({ m4: DISCONNECTED, linux: connected(SERVES_BOTS) }), false)
    syncBotHostListing(input({ m4: connected(SERVES_BOTS), linux: connected(SERVES_BOTS) }), false)
    stop()
    expect(changed).toEqual(['runtime:m4', 'runtime:linux', 'runtime:m4'])
  })
})

describe('refreshBotHost', () => {
  it('sends one list at a time to a server under a burst of changes, and none to the others', async () => {
    const servers = ['a', 'b', 'c', 'd', 'e']
    syncBotHostListing(
      input(Object.fromEntries(servers.map((id) => [id, connected(SERVES_BOTS)]))),
      false
    )
    const reads = Array.from({ length: 100 }, () => refreshBotHost('runtime:a'))
    await Promise.resolve()
    expect(calls.pending.map((call) => call.target)).toEqual([
      { kind: 'environment', environmentId: 'a' }
    ])
    calls.pending[0].resolve({ bots: [] })
    await vi.waitFor(() => expect(calls.pending).toHaveLength(2))
    calls.pending[1].resolve({ bots: [bot('triage')] })
    await Promise.all(reads)
    // The burst cost the one read out and one after it.
    expect(calls.pending).toHaveLength(2)
    expect(readBots().map((entry) => entry.hostId)).toEqual(['runtime:a'])
  })

  it('reads at most four servers at once when many come back together', async () => {
    const servers = Array.from({ length: 50 }, (_, index) => `s${index}`)
    syncBotHostListing(
      input(Object.fromEntries(servers.map((id) => [id, connected(SERVES_BOTS)]))),
      false
    )
    const reads = servers.map((id) => refreshBotHost(`runtime:${id}`))
    await vi.waitFor(() => expect(calls.pending).toHaveLength(4))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.pending).toHaveLength(4)
    calls.pending[0].resolve({ bots: [] })
    await vi.waitFor(() => expect(calls.pending).toHaveLength(5))
    for (let index = 1; index < servers.length; index++) {
      await vi.waitFor(() => expect(calls.pending.length).toBeGreaterThan(index))
      calls.pending[index].resolve({ bots: [] })
    }
    await Promise.all(reads)
    expect(calls.pending).toHaveLength(50)
  })

  it('gives up on servers that never answer, so the next one is read', async () => {
    vi.useFakeTimers()
    try {
      const servers = ['a', 'b', 'c', 'd', 'e']
      syncBotHostListing(
        input(Object.fromEntries(servers.map((id) => [id, connected(SERVES_BOTS)]))),
        false
      )
      const reads = servers.map((id) => refreshBotHost(`runtime:${id}`))
      await vi.advanceTimersByTimeAsync(0)
      expect(calls.pending).toHaveLength(4)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(calls.pending.map((call) => call.target)).toContainEqual({
        kind: 'environment',
        environmentId: 'e'
      })
      await vi.advanceTimersByTimeAsync(30_000)
      await Promise.all(reads)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never calls a disconnected server', async () => {
    syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), false)
    syncBotHostListing(input({ m4: DISCONNECTED }), false)
    await refreshBotHost('runtime:m4')
    expect(calls.pending).toEqual([])
  })
})
