import { describe, expect, it } from 'vitest'
import type { TerminalOutputSourceRange } from '../../../src/shared/terminal-output-source-range'
import {
  createRemoteTerminalSourceRangeContractFixture,
  type RemoteTerminalContractTopology
} from './remote-terminal-source-range-contract-fixture'

function sourceRange(): TerminalOutputSourceRange {
  return {
    id: 'pty-1',
    spanId: 'span-1',
    providerGeneration: 8,
    clientGeneration: 5,
    ownerGeneration: 3,
    ptyIncarnation: 'incarnation-1',
    deliveryToken: 'token-1',
    sourceStartSu: 0,
    sourceEndSu: 4,
    displayStart: 0,
    displayEnd: 4,
    splittable: true,
    transform: { transformed: false, rawLengthSu: 4, scalarSafe: true }
  }
}

describe.each<RemoteTerminalContractTopology>(['headed-desktop-server', 'headless-serve'])(
  '%s remote terminal source-range contract',
  (topology) => {
    it('keeps host identity and rejects a stale client generation after reconnect', () => {
      const fixture = createRemoteTerminalSourceRangeContractFixture(topology)
      const oldGeneration = fixture.connect()
      fixture.accept(4, [sourceRange()])
      fixture.detach()
      const generation = fixture.connect()
      fixture.accept(4, [sourceRange()])

      expect(fixture.hostPtyIdentity).toBe('host-owned-pty')
      expect(fixture.evidence).toBe('deterministic-contract-fixture')
      expect(fixture.acknowledge(oldGeneration, 4).status).toBe('stale-generation')
      expect(fixture.acknowledge(generation, 4).status).toBe('accepted')
      expect(fixture.snapshot()).toMatchObject({
        settled: [{ spanId: 'span-1' }],
        transferred: [{ spanId: 'span-1' }]
      })
    })
  }
)
