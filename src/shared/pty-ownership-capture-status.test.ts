import { expect, it } from 'vitest'
import { parsePtyOwnershipTransferDestinationStatus } from './pty-ownership-transfer-destination-status'
import { parsePtyOwnershipCaptureImportReceipt } from './pty-ownership-capture-import-receipt'

const identity = {
  bridgeId: 'bridge',
  terminalId: 'pty',
  incarnationId: 'incarnation',
  ownerLease: 'lease',
  sourceOwnerGeneration: 1,
  destinationRuntimeId: 'host'
}
const baseline = {
  version: 1,
  modelSha256: 'a'.repeat(64),
  boundary: {
    version: 1,
    identity,
    throughSeq: 20,
    delivery: {
      id: 'pty',
      ptyIncarnation: 'incarnation',
      ownerGeneration: 1,
      clientGeneration: 1,
      providerGeneration: 1,
      deliveryToken: 'token',
      state: 'active',
      windowSu: 1024,
      receivedEndSu: 100,
      sentEndSu: 100,
      creditedEndSu: 100,
      generationClosed: false,
      exitPublished: false
    }
  }
}
const status = {
  ...identity,
  version: 1,
  phase: 'prepared',
  destinationClaim: null,
  boundToConnection: false,
  sourceOutputEndSeq: 21,
  destinationAcknowledgedSeq: 0,
  captureBaseline: baseline
}

it('recognizes only the supported optional import acknowledgement capability', () => {
  expect(
    parsePtyOwnershipTransferDestinationStatus({ ...status, captureImportAckVersion: 1 })
  ).toHaveProperty('captureImportAckVersion', 1)
  for (const version of [undefined, 0, 2, true, '1']) {
    expect(
      parsePtyOwnershipTransferDestinationStatus({ ...status, captureImportAckVersion: version })
    ).not.toHaveProperty('captureImportAckVersion')
  }
})

it('keeps capture evidence optional for older sources and validates present evidence', () => {
  expect(
    parsePtyOwnershipTransferDestinationStatus({ ...status, captureBaseline: undefined })
  ).not.toHaveProperty('captureBaseline')
  const parsed = parsePtyOwnershipTransferDestinationStatus(status)
  expect(parsed.captureBaseline).toEqual(baseline)
  expect(parsed.sourceOutputEndSeq).toBe(21)
  expect(parsed.destinationAcknowledgedSeq).toBe(0)
})

it.each([
  { sourceOutputEndSeq: undefined },
  { sourceOutputEndSeq: 19 },
  { captureBaseline: { ...baseline, modelSha256: 'invalid' } },
  {
    captureBaseline: {
      ...baseline,
      boundary: { ...baseline.boundary, identity: { ...identity, terminalId: 'other' } }
    }
  },
  {
    phase: 'committed',
    destinationClaim: { generation: 1, claimId: 'claim' },
    receipt: {
      bridgeId: 'bridge',
      receiptId: 'receipt',
      acceptedSourceEndSeq: 21,
      committedAt: '2026-09-06T00:00:00.000Z'
    }
  }
])('refuses inconsistent source selection evidence: %j', (patch) => {
  expect(() => parsePtyOwnershipTransferDestinationStatus({ ...status, ...patch })).toThrow()
})

const receipt = { version: 1, identity, throughSeq: 20, modelSha256: baseline.modelSha256 }
it('parses a bounded import receipt independently of a moving source output cursor', () => {
  expect(
    parsePtyOwnershipCaptureImportReceipt({ ...receipt, futureField: true }, identity)
  ).toEqual(receipt)
})
it.each([
  null,
  {},
  { ...receipt, throughSeq: -1 },
  { ...receipt, modelSha256: 'X'.repeat(64) },
  { ...receipt, identity: { ...identity, destinationRuntimeId: 'other' } },
  { ...receipt, version: 2 }
])('refuses invalid import receipts: %j', (value) => {
  expect(() => parsePtyOwnershipCaptureImportReceipt(value, identity)).toThrow()
})
