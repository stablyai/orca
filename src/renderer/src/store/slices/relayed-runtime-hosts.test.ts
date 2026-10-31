import { afterEach, describe, expect, it, vi } from 'vitest'
import { RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY } from '../../../../shared/mobile-desktop-relay-contract'
import {
  runtimeEnvironmentStatusFromSnapshot,
  type RuntimeHostStatusSnapshot
} from '../../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { createTestStore } from './store-test-helpers'
import { selectRelayedRuntimeHostOwners } from './relayed-runtime-hosts'

type Call = { selector: string; method: string; params?: unknown }
type Answer = (call: Call) => Promise<RuntimeRpcResponse<unknown>>

let sequence = 0

function snapshot(
  patch: Partial<RuntimeHostStatusSnapshot> & { capable?: boolean } = {}
): RuntimeHostStatusSnapshot {
  const { capable = true, ...rest } = patch
  const status: RuntimeStatus = {
    runtimeId: 'r',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0,
    capabilities: capable ? [RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY] : []
  }
  return {
    environmentId: 'env-a',
    pairingRevision: 1,
    sequence: ++sequence,
    checkedAt: 1,
    status,
    verification: 'verified',
    transport: 'ready',
    ...rest
  }
}

function environment(pairingRevision = 1): PublicKnownRuntimeEnvironment {
  return {
    id: 'env-a',
    name: 'Studio',
    createdAt: 1,
    pairingRevision,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'e',
    endpoints: []
  }
}

const ok = (result: unknown): RuntimeRpcResponse<unknown> => ({
  id: 'x',
  ok: true,
  result,
  _meta: { runtimeId: 'r' }
})

const vm = { hostId: 'runtime:vm-1', label: 'VM', health: 'available', relay: 'ready' }

/** A relaying server listing one ready server whose rows are `rows`. */
function relaying(rows: unknown[] | null): Answer {
  return async ({ method }) =>
    method === 'mobileRelay.hosts.list'
      ? ok({ hosts: [vm] })
      : ok({ worktrees: rows?.map((worktreeId) => ({ worktreeId, branch: 'main' })) ?? null })
}

function createStore(answer: Answer, status = snapshot()) {
  const call = vi.fn(answer)
  vi.stubGlobal('window', { api: { runtimeEnvironments: { call } } })
  const store = createTestStore()
  // Set directly: setRuntimeEnvironments would also run revision and purge side effects.
  store.setState({
    runtimeEnvironments: [environment(status.pairingRevision)],
    runtimeStatusByEnvironmentId: new Map([['env-a', runtimeEnvironmentStatusFromSnapshot(status)]])
  })
  const setStatus = (next: RuntimeHostStatusSnapshot): void =>
    store.setState({
      runtimeStatusByEnvironmentId: new Map([['env-a', runtimeEnvironmentStatusFromSnapshot(next)]])
    })
  const listedRows = (): unknown =>
    selectRelayedRuntimeHostOwners(store.getState()).map((owner) =>
      owner.state === 'listed'
        ? owner.hosts.map((host) => host.worktrees?.map((row) => row.worktreeId) ?? null)
        : owner.state
    )
  return { store, call, setStatus, listedRows }
}

describe('relayed runtime hosts slice', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it.each([
    ['disconnected', snapshot({ transport: 'disconnected', verification: 'unavailable' })],
    ['unverified', snapshot({ verification: 'checking' })],
    ['unreachable', snapshot({ verification: 'unavailable' })],
    [
      'manually disconnected',
      snapshot({ retired: true, transport: 'disconnected', verification: 'blocked' })
    ],
    ['an earlier pairing', snapshot({ pairingRevision: 0 })],
    ['without the capability', snapshot({ capable: false })]
  ])('never calls a relaying server that is %s', async (_name, status) => {
    const { store, call } = createStore(relaying(['w-1']))
    store.setState({
      runtimeStatusByEnvironmentId: new Map([
        ['env-a', runtimeEnvironmentStatusFromSnapshot(status)]
      ])
    })
    await store.getState().refreshRelayedRuntimeHosts()
    expect(call).not.toHaveBeenCalled()
  })

  it('reads through the runtime call path pinned to the pairing, and keeps rows while out of contact', async () => {
    const { store, call, setStatus, listedRows } = createStore(relaying(['w-1']))
    await store.getState().refreshRelayedRuntimeHosts()
    expect(listedRows()).toEqual([[['w-1']]])
    expect(call).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-a',
        method: 'mobileRelay.hosts.list',
        expectedEnvironmentPairingRevision: 1
      })
    )

    // A brief drop keeps the last rows, like the phone, without asking the server.
    call.mockClear()
    setStatus(snapshot({ transport: 'disconnected', verification: 'unavailable' }))
    await store.getState().refreshRelayedRuntimeHosts()
    expect(call).not.toHaveBeenCalled()
    expect(listedRows()).toEqual([[['w-1']]])
  })

  it('drops an owner that reconnects without the relay capability', async () => {
    const { store, setStatus, listedRows } = createStore(relaying(['w-1']))
    await store.getState().refreshRelayedRuntimeHosts()
    setStatus(snapshot({ capable: false }))
    // The section drops it before any read.
    expect(listedRows()).toEqual([])
    await store.getState().refreshRelayedRuntimeHosts()
    expect(store.getState().relayedRuntimeHostOwners).toEqual([])
  })

  it('drops rows of a pairing replaced under the same id, and never shows them for the new one', async () => {
    const { store, setStatus, listedRows } = createStore(relaying(['w-1']))
    await store.getState().refreshRelayedRuntimeHosts()
    store.setState({ runtimeEnvironments: [environment(2)] })
    setStatus(snapshot({ pairingRevision: 2, transport: 'connecting', verification: 'checking' }))
    expect(listedRows()).toEqual([])
    await store.getState().refreshRelayedRuntimeHosts()
    expect(store.getState().relayedRuntimeHostOwners).toEqual([])
  })

  it('drops rows of an owner unpaired while its read was in flight', async () => {
    let answer: (response: RuntimeRpcResponse<unknown>) => void = () => {}
    const { store } = createStore(() => new Promise((resolve) => (answer = resolve)))
    const refreshing = store.getState().refreshRelayedRuntimeHosts()
    store.setState({ runtimeEnvironments: [], runtimeStatusByEnvironmentId: new Map() })
    answer(ok({ hosts: [] }))
    await refreshing
    expect(store.getState().relayedRuntimeHostOwners).toEqual([])
  })

  it('lets a newer read win over an older one that answers later', async () => {
    const pending: ((rows: string[]) => void)[] = []
    const { store, listedRows } = createStore(async ({ method }) => {
      if (method === 'mobileRelay.hosts.list') {
        return ok({ hosts: [vm] })
      }
      const rows = await new Promise<string[]>((resolve) => pending.push(resolve))
      return ok({ worktrees: rows.map((worktreeId) => ({ worktreeId })) })
    })
    const older = store.getState().refreshRelayedRuntimeHosts()
    const newer = store.getState().refreshRelayedRuntimeHosts()
    await vi.waitFor(() => expect(pending).toHaveLength(2))
    pending[1](['new'])
    await newer
    pending[0](['old'])
    await older
    expect(listedRows()).toEqual([[['new']]])
  })

  it('keeps the last rows and their identity through failed reads of the owner or one server', async () => {
    const answers: Answer[] = [
      relaying(['w-1']),
      relaying(null),
      async ({ method }) => {
        if (method === 'mobileRelay.hosts.list') {
          return ok({ hosts: [vm] })
        }
        throw new Error('timed out')
      },
      async () => {
        throw new Error('socket closed')
      }
    ]
    let current = answers[0]
    const { store } = createStore((request) => current(request))
    await store.getState().refreshRelayedRuntimeHosts()
    const first = store.getState().relayedRuntimeHostOwners
    for (const answer of answers) {
      current = answer
      await store.getState().refreshRelayedRuntimeHosts()
    }
    // Unchanged content keeps identity, so the sidebar section does not re-render on polls.
    expect(store.getState().relayedRuntimeHostOwners).toBe(first)
  })

  it('reports an owner it could never read as unavailable', async () => {
    const { store, listedRows } = createStore(async () => ok({ hosts: 'nope' }))
    await store.getState().refreshRelayedRuntimeHosts()
    expect(listedRows()).toEqual(['unavailable'])
  })
})
