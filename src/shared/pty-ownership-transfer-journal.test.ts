import { describe, expect, it } from 'vitest'
import {
  assertPtyOwnershipTransferIdentity,
  normalizePtyOwnershipTransferJournals,
  parsePtyOwnershipTransferJournal
} from './pty-ownership-transfer-journal'
import {
  parsePtyOwnershipTransferPrepareRequest,
  parsePtyOwnershipTransferPublishRequest
} from './pty-ownership-transfer-wire'

const base = {
  version: 1,
  bridgeId: 'bridge-1',
  terminalId: 'terminal-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-bun-1',
  startedAt: '2026-08-30T12:00:00.000Z',
  updatedAt: '2026-08-30T12:00:00.000Z'
}

const commitReceipt = {
  receiptId: 'receipt-1',
  bridgeId: 'bridge-1',
  acceptedSourceEndSeq: 4,
  committedAt: '2026-08-30T12:01:00.000Z'
}

const publicationReceipt = {
  version: 1,
  publicationReceiptId: 'publication-1',
  bridgeId: 'bridge-1',
  destinationRuntimeId: 'runtime-bun-1',
  commitReceipt,
  publishedAt: '2026-08-30T12:02:00.000Z'
}

const surfaceBinding = {
  executionHostId: 'local',
  workspaceKey: 'folder:folder-1',
  tabId: 'tab-1',
  leafId: '11111111-1111-4111-8111-111111111111',
  ptyId: 'terminal-1'
}

describe('PTY ownership transfer journal contract', () => {
  it('accepts role-specific prepare records and exact commit receipts', () => {
    const source = parsePtyOwnershipTransferJournal({
      ...base,
      side: 'source',
      phase: 'prepared',
      sourceOutputEndSeq: 4,
      destinationOutputEndSeq: 0
    })
    const destination = parsePtyOwnershipTransferJournal({
      ...base,
      side: 'destination',
      phase: 'published',
      acceptedSourceEndSeq: 4,
      receipt: commitReceipt,
      publicationReceipt
    })
    expect(source).toMatchObject({ side: 'source', phase: 'prepared' })
    expect(destination).toMatchObject({ side: 'destination', phase: 'published' })
  })

  it('rejects cursor, receipt, and phase combinations that could authorize loss', () => {
    expect(() =>
      parsePtyOwnershipTransferJournal({
        ...base,
        side: 'source',
        phase: 'prepared',
        sourceOutputEndSeq: 2,
        destinationOutputEndSeq: 3
      })
    ).toThrow('pty_ownership_transfer_destination_output_ahead')
    expect(() =>
      parsePtyOwnershipTransferJournal({
        ...base,
        side: 'destination',
        phase: 'committed',
        acceptedSourceEndSeq: 4
      })
    ).toThrow('pty_ownership_transfer_destination_receipt_phase_mismatch')
    expect(() =>
      parsePtyOwnershipTransferJournal({
        ...base,
        side: 'source',
        phase: 'commit-observed',
        sourceOutputEndSeq: 4,
        destinationOutputEndSeq: 4,
        receipt: {
          receiptId: 'receipt-1',
          bridgeId: 'other-bridge',
          acceptedSourceEndSeq: 4,
          committedAt: '2026-08-30T12:01:00.000Z'
        }
      })
    ).toThrow('pty_ownership_transfer_receipt_identity_mismatch')
    expect(() =>
      parsePtyOwnershipTransferJournal({
        ...base,
        side: 'source',
        phase: 'retired',
        sourceOutputEndSeq: 4,
        destinationOutputEndSeq: 4,
        receipt: commitReceipt
      })
    ).toThrow('pty_ownership_transfer_source_publication_phase_mismatch')
    expect(() =>
      parsePtyOwnershipTransferJournal({
        ...base,
        side: 'destination',
        phase: 'published',
        acceptedSourceEndSeq: 4,
        receipt: commitReceipt,
        publicationReceipt: {
          ...publicationReceipt,
          destinationRuntimeId: 'other-runtime'
        }
      })
    ).toThrow('pty_ownership_transfer_publication_receipt_mismatch')
  })

  it('round-trips additive surface proof and rejects malformed binding identity', () => {
    const destination = parsePtyOwnershipTransferJournal({
      ...base,
      side: 'destination',
      phase: 'published',
      acceptedSourceEndSeq: 4,
      receipt: commitReceipt,
      publicationReceipt: { ...publicationReceipt, surfaceBinding }
    })
    expect(destination).toMatchObject({
      publicationReceipt: { surfaceBinding }
    })
    expect(() =>
      parsePtyOwnershipTransferJournal({
        ...base,
        side: 'destination',
        phase: 'published',
        acceptedSourceEndSeq: 4,
        receipt: commitReceipt,
        publicationReceipt: {
          ...publicationReceipt,
          surfaceBinding: { ...surfaceBinding, workspaceKey: 'folder:' }
        }
      })
    ).toThrow('pty_ownership_transfer_surface_binding_invalid')
  })

  it('keeps the wire surface proof additive for legacy publication receipts', () => {
    const identity = {
      version: 1 as const,
      bridgeId: base.bridgeId,
      terminalId: base.terminalId,
      incarnationId: base.incarnationId,
      ownerLease: base.ownerLease,
      sourceOwnerGeneration: base.sourceOwnerGeneration,
      destinationRuntimeId: base.destinationRuntimeId
    }
    expect(
      parsePtyOwnershipTransferPublishRequest({
        ...identity,
        publicationReceipt: { ...publicationReceipt, surfaceBinding }
      }).publicationReceipt.surfaceBinding
    ).toEqual(surfaceBinding)
    expect(
      parsePtyOwnershipTransferPublishRequest({
        ...identity,
        publicationReceipt
      }).publicationReceipt.surfaceBinding
    ).toBeUndefined()
  })

  it('keeps surface-publication prepare negotiation additive and validates its version', () => {
    const identity = {
      version: 1 as const,
      bridgeId: base.bridgeId,
      terminalId: base.terminalId,
      incarnationId: base.incarnationId,
      ownerLease: base.ownerLease,
      sourceOwnerGeneration: base.sourceOwnerGeneration,
      destinationRuntimeId: base.destinationRuntimeId
    }
    expect(
      parsePtyOwnershipTransferPrepareRequest({
        ...identity,
        surfacePublication: { version: 1, surfaceBinding }
      }).surfacePublication
    ).toEqual({ version: 1, surfaceBinding })
    expect(parsePtyOwnershipTransferPrepareRequest(identity).surfacePublication).toBeUndefined()
    expect(() =>
      parsePtyOwnershipTransferPrepareRequest({
        ...identity,
        surfacePublication: { version: 2, surfaceBinding }
      })
    ).toThrow('pty_ownership_transfer_surface_publication_version_unsupported')
  })

  it('normalizes malformed entries away and keeps the bounded newest set', () => {
    const valid = {
      ...base,
      side: 'source',
      phase: 'prepared',
      sourceOutputEndSeq: 0,
      destinationOutputEndSeq: 0
    }
    expect(
      normalizePtyOwnershipTransferJournals([
        valid,
        { ...valid, bridgeId: 'bridge-2' },
        { ...valid, phase: 'not-a-phase' },
        { ...valid, bridgeId: 'bridge-2', sourceOutputEndSeq: 1 }
      ])
    ).toEqual([
      expect.objectContaining({ bridgeId: 'bridge-1', sourceOutputEndSeq: 0 }),
      expect.objectContaining({ bridgeId: 'bridge-2', sourceOutputEndSeq: 1 })
    ])
  })

  it('normalizes recovery records without Node 20-only array methods', () => {
    const prototype = Array.prototype as unknown as { toReversed?: unknown }
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'toReversed')
    const valid = {
      ...base,
      side: 'source',
      phase: 'prepared',
      sourceOutputEndSeq: 0,
      destinationOutputEndSeq: 0
    }
    try {
      Object.defineProperty(prototype, 'toReversed', {
        configurable: true,
        value: undefined,
        writable: true
      })
      const input = Object.freeze([valid, { ...valid, bridgeId: 'bridge-2' }])
      expect(normalizePtyOwnershipTransferJournals(input)).toEqual([
        expect.objectContaining({ bridgeId: 'bridge-1' }),
        expect.objectContaining({ bridgeId: 'bridge-2' })
      ])
    } finally {
      if (descriptor) {
        Object.defineProperty(prototype, 'toReversed', descriptor)
      } else {
        delete prototype.toReversed
      }
    }
  })

  it.each([
    { bridgeId: 'other' },
    { terminalId: 'other' },
    { incarnationId: 'other' },
    { ownerLease: 'other' },
    { sourceOwnerGeneration: 4 },
    { destinationRuntimeId: 'other' }
  ])('rejects every changed journal identity field: %j', (change) => {
    const journal = parsePtyOwnershipTransferJournal({
      ...base,
      side: 'source',
      phase: 'prepared',
      sourceOutputEndSeq: 0,
      destinationOutputEndSeq: 0
    })
    expect(() => assertPtyOwnershipTransferIdentity(journal, base)).not.toThrow()
    expect(() => assertPtyOwnershipTransferIdentity(journal, { ...base, ...change })).toThrow(
      'pty_ownership_transfer_identity_conflict'
    )
  })
})
