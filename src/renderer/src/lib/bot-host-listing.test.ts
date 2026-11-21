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
  readBotHostConnectorStatus,
  readBotHostListed,
  readHasBot,
  readBotHostIds,
  readBots,
  readUpdateNeededBotHosts,
  setBotHostListing
} from './bot-catalog-snapshot'
import { beginBotHostUpdate, refreshBotHost } from './bot-host-refresh'
import {
  botHostLinkReadMark,
  botHostLinkReadSince,
  noteBotHostCameBack,
  noteBotHostLinkRead,
  sendBotHostLinkRead
} from './bot-host-link-read'
import { renderHook } from '@testing-library/react'
import {
  refreshBotHostOrcaAccount,
  useBotHostOrcaAccountReading,
  useBotHostOrcaAccounts,
  useBotHostOrcaAccountSettled
} from './bot-host-orca-account'
import {
  emitPairedBotsStreamCameBack,
  syncBotHostListing,
  type BotHostListingInput
} from './bot-host-listing'
import { onBotsChanged } from './bots-changed-window-event'

type PendingCall = {
  target: unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}
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
      calls.pending.push({ target, resolve, reject })
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

// What a card that opened at `mark` may act on: only a read of the host's link sent after it, landed.
describe("a host's link read since a view opened", () => {
  const M4 = 'runtime:m4'
  const answer = { bots: [], connectorStatus: 'ok' }

  it('never counts a read sent before the view opened, however late it lands', async () => {
    syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), false)
    const early = refreshBotHost(M4)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(1))
    const mark = botHostLinkReadMark()
    const after = refreshBotHost(M4)
    calls.pending[0].resolve(answer)
    await early
    expect(botHostLinkReadSince(M4, mark)).toBe(false)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(2))
    calls.pending[1].resolve(answer)
    await after
    expect(botHostLinkReadSince(M4, mark)).toBe(true)
  })

  it('stops counting a read from before the server went away until it reads again', async () => {
    syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), false)
    const mark = botHostLinkReadMark()
    const first = refreshBotHost(M4)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(1))
    calls.pending[0].resolve(answer)
    await first
    expect(botHostLinkReadSince(M4, mark)).toBe(true)

    syncBotHostListing(input({ m4: DISCONNECTED }), false)
    // Back: the read from before proves nothing until the re-read its return asks for lands.
    syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), false)
    expect(botHostLinkReadSince(M4, mark)).toBe(false)
    const reread = refreshBotHost(M4)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(2))
    expect(botHostLinkReadSince(M4, mark)).toBe(false)
    calls.pending[1].resolve(answer)
    await reread
    expect(botHostLinkReadSince(M4, mark)).toBe(true)
  })

  it('stops counting once a later read fails, and never counts a read an edit set aside', async () => {
    vi.useFakeTimers()
    try {
      syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), false)
      const mark = botHostLinkReadMark()
      const first = refreshBotHost(M4)
      await vi.advanceTimersByTimeAsync(0)
      calls.pending[0].resolve(answer)
      await first
      expect(botHostLinkReadSince(M4, mark)).toBe(true)
      const failing = refreshBotHost(M4)
      await vi.advanceTimersByTimeAsync(30_000)
      await failing
      expect(botHostLinkReadSince(M4, mark)).toBe(false)

      // An edit starts while the read is out: its answer is set aside, so it says nothing.
      const setAside = refreshBotHost(M4)
      await vi.advanceTimersByTimeAsync(0)
      const end = beginBotHostUpdate(M4)
      calls.pending[2].resolve(answer)
      await setAside
      expect(botHostLinkReadSince(M4, mark)).toBe(false)
      const reread = end()
      await vi.advanceTimersByTimeAsync(0)
      calls.pending[3].resolve(answer)
      await reread
      expect(botHostLinkReadSince(M4, mark)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

// A server that went away and came back may have changed: what was still out from before says nothing.
describe('reads still out when a server goes away and comes back', () => {
  const M4 = 'runtime:m4'

  it('drops a late bots.list from before, link and status both, until the re-read lands', async () => {
    syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), false)
    const signedOut = refreshBotHost(M4)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(1))
    calls.pending[0].resolve({ bots: [], connectorStatus: 'signed-out' })
    await signedOut
    const mark = botHostLinkReadMark()
    const old = refreshBotHost(M4)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(2))
    syncBotHostListing(input({ m4: DISCONNECTED }), false)
    syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), false)
    const reread = refreshBotHost(M4)
    calls.pending[1].resolve({ bots: [], connectorStatus: 'ok' })
    await old
    expect(botHostLinkReadSince(M4, mark)).toBe(false)
    expect(readBotHostConnectorStatus(M4)).toBe('signed-out')
    await vi.waitFor(() => expect(calls.pending).toHaveLength(3))
    calls.pending[2].resolve({ bots: [], connectorStatus: 'ok' })
    await reread
    expect(botHostLinkReadSince(M4, mark)).toBe(true)
    expect(readBotHostConnectorStatus(M4)).toBe('ok')
  })

  it('never counts a link read sent before the host came back, whoever notes it', () => {
    const mark = botHostLinkReadMark()
    const ticket = sendBotHostLinkRead(M4)
    noteBotHostCameBack(M4)
    noteBotHostLinkRead(M4, true, ticket)
    expect(botHostLinkReadSince(M4, mark)).toBe(false)
    noteBotHostLinkRead(M4, true, sendBotHostLinkRead(M4))
    expect(botHostLinkReadSince(M4, mark)).toBe(true)
  })

  it('drops a late account read from before, and reads it as unsettled until one sent since lands', async () => {
    syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), false)
    const view = renderHook(() => ({
      account: useBotHostOrcaAccounts([M4])[0],
      settled: useBotHostOrcaAccountSettled(M4),
      reading: useBotHostOrcaAccountReading(M4)
    }))
    const first = refreshBotHostOrcaAccount(M4)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(1))
    calls.pending[0].resolve({ state: 'signed-out', storage: { kind: 'os-keychain' } })
    await first
    const old = refreshBotHostOrcaAccount(M4)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(2))
    syncBotHostListing(input({ m4: DISCONNECTED }), false)
    syncBotHostListing(input({ m4: connected(SERVES_BOTS) }), false)
    calls.pending[1].resolve({ state: 'signed-in', storage: { kind: 'os-keychain' } })
    await old
    await vi.waitFor(() => expect(view.result.current.settled).toBe(false))
    expect(view.result.current.account?.state).toBe('signed-out')
    expect(view.result.current.reading).toBe(false)

    const reread = refreshBotHostOrcaAccount(M4)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(3))
    // The re-read is out: the late answer from before never became the account read.
    await vi.waitFor(() => expect(view.result.current.reading).toBe(true))
    expect(view.result.current.account?.state).toBe('signed-out')
    calls.pending[2].resolve({ state: 'signed-in', storage: { kind: 'os-keychain' } })
    await reread
    await vi.waitFor(() => expect(view.result.current.settled).toBe(true))
    expect(view.result.current.account?.state).toBe('signed-in')
    view.unmount()
  })
})

// The event stream came back after lost changes while the server stayed listed: same as coming back.
describe("a server's event stream that comes back while it stays listed", () => {
  it('drops a late list and account read from before, until reads sent since land', async () => {
    const M7 = 'runtime:m7'
    syncBotHostListing(input({ m7: connected(SERVES_BOTS) }), false)
    const view = renderHook(() => ({
      account: useBotHostOrcaAccounts([M7])[0],
      settled: useBotHostOrcaAccountSettled(M7)
    }))
    const signedOut = refreshBotHost(M7)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(1))
    calls.pending[0].resolve({ bots: [], connectorStatus: 'signed-out' })
    await signedOut
    const firstAccount = refreshBotHostOrcaAccount(M7)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(2))
    calls.pending[1].resolve({ state: 'signed-out', storage: { kind: 'os-keychain' } })
    await firstAccount
    const mark = botHostLinkReadMark()
    const oldList = refreshBotHost(M7)
    const oldAccount = refreshBotHostOrcaAccount(M7)
    await vi.waitFor(() => expect(calls.pending).toHaveLength(4))

    emitPairedBotsStreamCameBack('m7')
    calls.pending[2].resolve({ bots: [], connectorStatus: 'ok' })
    calls.pending[3].resolve({ state: 'signed-in', storage: { kind: 'os-keychain' } })
    await Promise.all([oldList, oldAccount])
    expect(botHostLinkReadSince(M7, mark)).toBe(false)
    expect(readBotHostConnectorStatus(M7)).toBe('signed-out')
    await vi.waitFor(() => expect(view.result.current.settled).toBe(false))
    expect(view.result.current.account?.state).toBe('signed-out')
    view.unmount()
  })

  it("never marks a server's first list failed for a read from before that fails late", async () => {
    vi.useFakeTimers()
    try {
      const M8 = 'runtime:m8'
      syncBotHostListing(input({ m8: connected(SERVES_BOTS) }), false)
      const old = refreshBotHost(M8)
      await vi.advanceTimersByTimeAsync(0)
      expect(calls.pending).toHaveLength(1)
      emitPairedBotsStreamCameBack('m8')
      calls.pending[0].reject(new Error('stream reset'))
      await old
      expect(readBotHostListed(M8)).toBe(false)
      expect(readHasBot()).not.toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
