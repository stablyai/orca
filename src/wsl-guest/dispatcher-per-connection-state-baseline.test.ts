import { describe, expect, it, vi, afterEach } from 'vitest'
import { RelayDispatcher } from './dispatcher'

// Count retained containers after churn; exact state counts prove release without timing-dependent assertions.

type Probed = {
  attachClient: RelayDispatcher['attachClient']
  detachClient: (id: number) => void
  onClientCapacity: (id: number, listener: () => void) => (() => void) | null
  clients: Map<number, unknown>
  requestHandlers: Map<string, unknown>
  notificationHandlers: Map<string, unknown>
  requestAborts: {
    byClient: Map<number, Map<string, AbortController>>
    create: (clientId: number, requestId: number) => unknown
  }
  publicationLedger: { clientBytes: Map<string, number>; aggregateBytes: number }
  pendingRelayRequests: Map<number, unknown>
  clientDetachListeners: Set<unknown>
  disposeListeners: Set<unknown>
  legacyCapacityListeners: Set<unknown>
  clientCapacityListeners: Map<number, unknown>
  ptyDataPublicationAdmission: unknown
  keepaliveTimer: unknown
  activeClients: () => unknown[]
  tryPublishToClients: (clients: unknown[], msg: unknown, lane: string) => boolean
  dispose: () => void
}

function countAbortControllers(d: Probed): number {
  let total = 0
  for (const bucket of d.requestAborts.byClient.values()) {
    total += bucket.size
  }
  return total
}

function census(d: Probed) {
  return {
    clients: d.clients.size,
    requestHandlers: d.requestHandlers.size,
    notificationHandlers: d.notificationHandlers.size,
    requestAbortControllers: countAbortControllers(d),
    ledgerClientBytes: d.publicationLedger.clientBytes.size,
    ledgerAggregateBytes: d.publicationLedger.aggregateBytes,
    pendingRelayRequests: d.pendingRelayRequests.size,
    clientDetachListeners: d.clientDetachListeners.size,
    disposeListeners: d.disposeListeners.size,
    legacyCapacityListeners: d.legacyCapacityListeners.size,
    clientCapacityListeners: d.clientCapacityListeners.size,
    ptyDataPublicationAdmission: d.ptyDataPublicationAdmission === null ? 'null' : 'set',
    keepaliveTimer: d.keepaliveTimer === null ? 'null' : 'armed'
  }
}

function newDispatcher(): Probed {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Probed names the protected containers this census counts. RelayDispatcher really has them; the compiler just will not hand them out.
  return new RelayDispatcher(() => {}) as unknown as Probed
}

const CLIENTS_PER_CYCLE = 100

describe('relay dispatcher per-connection state', () => {
  afterEach(() => vi.useRealTimers())

  it('returns every per-connection container to baseline across repeated churn', () => {
    vi.useFakeTimers()
    const d = newDispatcher()
    const baseline = census(d)

    for (let cycle = 0; cycle < 3; cycle++) {
      const ids: number[] = []
      for (let i = 0; i < CLIENTS_PER_CYCLE; i++) {
        ids.push(d.attachClient(() => true, { supportsWriteCallback: true }))
      }
      for (const id of ids) {
        d.onClientCapacity(id, () => {})
        d.requestAborts.create(id, 1)
      }

      expect(census(d).clients).toBe(CLIENTS_PER_CYCLE + 1)
      expect(census(d).clientCapacityListeners).toBe(CLIENTS_PER_CYCLE)
      expect(census(d).requestAbortControllers).toBe(CLIENTS_PER_CYCLE)

      expect(
        d.tryPublishToClients(
          d.activeClients(),
          { jsonrpc: '2.0', method: 'pty.data', params: { d: 'x'.repeat(256) } },
          'bulk'
        )
      ).toBe(true)
      // Pending sink callbacks retain publication leases until detach closes each writer.
      expect(census(d).ledgerClientBytes).toBe(CLIENTS_PER_CYCLE)
      expect(census(d).ledgerAggregateBytes).toBeGreaterThan(baseline.ledgerAggregateBytes)
      for (const id of ids) {
        d.detachClient(id)
      }
      expect(census(d)).toEqual(baseline)
    }
    d.dispose()
  })
})
