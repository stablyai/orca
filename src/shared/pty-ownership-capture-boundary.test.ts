import { expect, it } from 'vitest'
import { parsePtyOwnershipCaptureBoundary } from './pty-ownership-capture-boundary'

const identity = {
  bridgeId: 'bridge',
  terminalId: 'pty',
  incarnationId: 'incarnation',
  ownerLease: 'lease',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime'
}
const boundary = {
  version: 1,
  identity,
  throughSeq: 20,
  delivery: {
    id: 'pty',
    ptyIncarnation: 'incarnation',
    providerGeneration: 1,
    clientGeneration: 2,
    ownerGeneration: 3,
    deliveryToken: 'token',
    state: 'active',
    windowSu: 256,
    receivedEndSu: 100,
    sentEndSu: 100,
    creditedEndSu: 100,
    generationClosed: false,
    exitPublished: false
  }
}

it('keeps transfer frame and source-unit positions distinct and returns immutable copies', () => {
  const parsed = parsePtyOwnershipCaptureBoundary({ ...boundary, futureField: true }, identity)
  expect(parsed).toEqual(boundary)
  expect(parsed.throughSeq).toBe(20)
  expect(parsed.delivery.receivedEndSu).toBe(100)
  expect(parsed.identity).not.toBe(identity)
  expect(Object.isFrozen(parsed.delivery)).toBe(true)
  expect(parsed).not.toHaveProperty('futureField')
})

it.each([
  null,
  {},
  { ...boundary, version: 2 },
  { ...boundary, throughSeq: -1 },
  { ...boundary, throughSeq: Number.MAX_SAFE_INTEGER + 1 },
  { ...boundary, identity: { ...identity, destinationRuntimeId: 'other' } }
])('rejects malformed or mismatched boundary: %j', (value) => {
  expect(() => parsePtyOwnershipCaptureBoundary(value, identity)).toThrow()
})

it.each([
  { id: 'other' },
  { ptyIncarnation: 'other' },
  { ownerGeneration: 4 },
  { clientGeneration: 0 },
  { providerGeneration: -1 },
  { windowSu: 0 },
  { deliveryToken: '' },
  { deliveryToken: 'x'.repeat(513) },
  { state: 'closed' },
  { generationClosed: true },
  { exitPublished: true },
  { sentEndSu: 99 },
  { creditedEndSu: 99 },
  { receivedEndSu: -1, sentEndSu: -1, creditedEndSu: -1 }
])('rejects unusable delivery evidence: %j', (patch) => {
  expect(() =>
    parsePtyOwnershipCaptureBoundary(
      { ...boundary, delivery: { ...boundary.delivery, ...patch } },
      identity
    )
  ).toThrow()
})
