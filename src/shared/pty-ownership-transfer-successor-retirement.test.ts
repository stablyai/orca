import { expect, it } from 'vitest'
import {
  parsePtyOwnershipTransferSuccessorRetirementRequest as parseRequest,
  parsePtyOwnershipTransferSuccessorRetirementResult as parseResult
} from './pty-ownership-transfer-successor-retirement'

function fixture(receivedEndSu = 28, sentEndSu = 28) {
  const identity = {
    terminalId: 'pty',
    incarnationId: 'incarnation',
    ownerLease: 'owner',
    sourceOwnerGeneration: 1,
    bridgeId: 'bridge',
    destinationRuntimeId: 'runtime'
  }
  const delivery = {
    id: 'pty',
    ptyIncarnation: 'incarnation',
    ownerGeneration: 1,
    providerGeneration: 1,
    clientGeneration: 1,
    deliveryToken: 'token',
    state: 'active',
    windowSu: 256,
    receivedEndSu: 20,
    sentEndSu: 20,
    creditedEndSu: 20,
    exitPublished: false,
    generationClosed: false
  }
  const request = {
    ...identity,
    version: 1,
    successorGeneration: 2,
    recoveryOnly: false,
    retirementRecordSha256: 'a'.repeat(64),
    savedBaseline: {
      version: 1,
      modelSha256: 'b'.repeat(64),
      boundary: { version: 1, identity, throughSeq: 5, delivery }
    }
  }
  const result = {
    ...identity,
    version: 1,
    coveredSourceDeliveryRetirement: {
      phase: 'retired',
      retirementRecordSha256: request.retirementRecordSha256,
      modelSha256: request.savedBaseline.modelSha256,
      sourceOutputEndSeq: 12,
      receipt: {
        receiptId: 'receipt',
        bridgeId: 'bridge',
        acceptedSourceEndSeq: 5,
        committedAt: '2026-09-08T00:00:00.000Z'
      },
      delivery: { ...delivery, receivedEndSu, sentEndSu }
    },
    sourceCancellation: { canceled: true, sentEndSu, creditedEndSu: 20 }
  }
  return { request, result }
}

it.each([
  [28, 28],
  [320, 276]
])('retains actual unacknowledged counters received=%s sent=%s', (received, sent) => {
  const { request, result } = fixture(received, sent)
  expect(parseResult(result, request)).toEqual(result)
  expect(parseResult(result, request).coveredSourceDeliveryRetirement.delivery.creditedEndSu).toBe(
    20
  )
})

it.each([false, true])('preserves explicit recoveryOnly=%s', (recoveryOnly) => {
  expect(parseRequest({ ...fixture().request, recoveryOnly }).recoveryOnly).toBe(recoveryOnly)
})

it('returns independent frozen canonical request and result trees', () => {
  const { request, result } = fixture()
  const parsedRequest = parseRequest({ ...request, extra: 'ignored' })
  const parsedResult = parseResult({ ...result, extra: 'ignored' }, request)
  expect(parsedRequest).toEqual(request)
  expect(parsedResult).toEqual(result)
  const boundary = parsedRequest.savedBaseline.boundary
  const retirement = parsedResult.coveredSourceDeliveryRetirement
  for (const value of [
    parsedRequest,
    parsedRequest.savedBaseline,
    boundary,
    boundary.identity,
    boundary.delivery,
    parsedResult,
    retirement,
    retirement.delivery,
    retirement.receipt,
    parsedResult.sourceCancellation
  ]) {
    expect(Object.isFrozen(value)).toBe(true)
  }
  request.savedBaseline.boundary.delivery.deliveryToken = 'changed'
  request.savedBaseline.boundary.identity.ownerLease = 'changed'
  result.coveredSourceDeliveryRetirement.delivery.receivedEndSu = 99
  result.coveredSourceDeliveryRetirement.receipt.receiptId = 'changed'
  result.sourceCancellation.sentEndSu = 99
  expect(boundary.delivery.deliveryToken).toBe('token')
  expect(boundary.identity.ownerLease).toBe('owner')
  expect(retirement.delivery.receivedEndSu).toBe(28)
  expect(retirement.receipt.receiptId).toBe('receipt')
  expect(parsedResult.sourceCancellation.sentEndSu).toBe(28)
})

it.each([
  ['version', undefined],
  ['version', 2],
  ['savedBaseline', undefined],
  ['savedBaseline', {}],
  ['retirementRecordSha256', undefined],
  ['retirementRecordSha256', 'A'.repeat(64)],
  ['retirementRecordSha256', 'a'.repeat(63)],
  ['successorGeneration', undefined],
  ['successorGeneration', 1],
  ['successorGeneration', 0],
  ['successorGeneration', -1],
  ['successorGeneration', 2.5],
  ['successorGeneration', Number.MAX_SAFE_INTEGER + 1],
  ['successorGeneration', Infinity],
  ['successorGeneration', '2'],
  ['recoveryOnly', undefined],
  ['recoveryOnly', null],
  ['recoveryOnly', 1],
  ['recoveryOnly', 'true']
])('rejects invalid request %s=%j', (key, value) => {
  expect(() => parseRequest({ ...fixture().request, [key]: value })).toThrow()
})

it.each(['terminalId', 'incarnationId', 'ownerLease', 'bridgeId', 'destinationRuntimeId'])(
  'rejects result identity mismatch %s',
  (key) => {
    const { request, result } = fixture()
    expect(() => parseResult({ ...result, [key]: 'different' }, request)).toThrow()
  }
)

it.each([
  { version: undefined },
  { version: 2 },
  { sourceOwnerGeneration: 2 },
  { coveredSourceDeliveryRetirement: undefined },
  { sourceCancellation: undefined },
  { sourceDeliveryRetirement: { phase: 'retired' } }
])('rejects incomplete or ordinary result %j', (patch) => {
  const { request, result } = fixture()
  expect(() => parseResult({ ...result, ...patch }, request)).toThrow()
})

it.each([
  { phase: 'retiring' },
  { retirementRecordSha256: 'c'.repeat(64) },
  { modelSha256: 'c'.repeat(64) },
  { sourceOutputEndSeq: 4 },
  { sourceOutputEndSeq: 5.5 },
  { sourceOutputEndSeq: undefined },
  { receipt: undefined }
])('rejects changed retirement evidence %j', (patch) => {
  const { request, result } = fixture()
  expect(() =>
    parseResult(
      {
        ...result,
        coveredSourceDeliveryRetirement: {
          ...result.coveredSourceDeliveryRetirement,
          ...patch
        }
      },
      request
    )
  ).toThrow()
})

it.each([
  { bridgeId: 'other' },
  { acceptedSourceEndSeq: 4 },
  { acceptedSourceEndSeq: 6 },
  { receiptId: '' },
  { committedAt: 'invalid' }
])('rejects invalid receipt %j', (patch) => {
  const { request, result } = fixture()
  const retirement = result.coveredSourceDeliveryRetirement
  expect(() =>
    parseResult(
      {
        ...result,
        coveredSourceDeliveryRetirement: {
          ...retirement,
          receipt: { ...retirement.receipt, ...patch }
        }
      },
      request
    )
  ).toThrow()
})

it.each([{ canceled: false }, { sentEndSu: 27 }, { creditedEndSu: 21 }])(
  'rejects mismatched cancellation %j',
  (patch) => {
    const { request, result } = fixture()
    expect(() =>
      parseResult(
        {
          ...result,
          sourceCancellation: {
            ...result.sourceCancellation,
            ...patch
          }
        },
        request
      )
    ).toThrow()
  }
)

it.each([
  { deliveryToken: 'other' },
  { windowSu: 512 },
  { ownerGeneration: 2 },
  { providerGeneration: 2 },
  { clientGeneration: 2 },
  { id: 'other' },
  { ptyIncarnation: 'other' },
  { state: 'closed' },
  { generationClosed: true },
  { exitPublished: true },
  { receivedEndSu: 19 },
  { receivedEndSu: 27 },
  { receivedEndSu: Number.NaN },
  { receivedEndSu: Number.MAX_SAFE_INTEGER + 1 },
  { sentEndSu: 19 },
  { sentEndSu: 29 },
  { creditedEndSu: 19 },
  { creditedEndSu: 29 },
  { receivedEndSu: 300, sentEndSu: 277 },
  { sentEndSu: 20.5 },
  { creditedEndSu: 20.5 }
])('rejects changed delivery identity or invalid actual counters %j', (patch) => {
  const { request, result } = fixture()
  const retirement = result.coveredSourceDeliveryRetirement
  const delivery = { ...retirement.delivery, ...patch }
  expect(() =>
    parseResult(
      {
        ...result,
        coveredSourceDeliveryRetirement: { ...retirement, delivery },
        sourceCancellation: {
          canceled: true,
          sentEndSu: delivery.sentEndSu,
          creditedEndSu: delivery.creditedEndSu
        }
      },
      request
    )
  ).toThrow()
})
