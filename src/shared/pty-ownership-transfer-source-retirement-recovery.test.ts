import { expect, it } from 'vitest'
import {
  parsePtyOwnershipTransferSourceRetirementRequest,
  parsePtyOwnershipTransferSourceRetirementEvidence
} from './pty-ownership-transfer-source-retirement'

const identity = {
  terminalId: 'pty',
  incarnationId: 'incarnation',
  ownerLease: 'owner',
  sourceOwnerGeneration: 1,
  bridgeId: 'bridge',
  destinationRuntimeId: 'runtime'
}
const request = {
  ...identity,
  version: 1,
  credential: 'a'.repeat(64),
  destinationClaim: { generation: 1, claimId: 'claim' },
  retirementRecordSha256: 'b'.repeat(64)
}
const evidence = {
  ...identity,
  version: 1,
  sourceDeliveryRetirement: {
    phase: 'retired',
    retirementRecordSha256: request.retirementRecordSha256,
    delivery: {
      id: identity.terminalId,
      ptyIncarnation: identity.incarnationId,
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
  }
}

it.each([true, false])('preserves optional recoveryOnly=%s', (recoveryOnly) => {
  expect(
    parsePtyOwnershipTransferSourceRetirementRequest({ ...request, recoveryOnly }).recoveryOnly
  ).toBe(recoveryOnly)
})
it('keeps normal request and evidence shapes unchanged', () => {
  expect(parsePtyOwnershipTransferSourceRetirementRequest(request)).not.toHaveProperty(
    'recoveryOnly'
  )
  expect(parsePtyOwnershipTransferSourceRetirementEvidence(evidence)).not.toHaveProperty(
    'sourceCancellation'
  )
})
it.each([null, 1, 'true', {}, []])('rejects invalid recovery flag %j', (recoveryOnly) => {
  expect(() =>
    parsePtyOwnershipTransferSourceRetirementRequest({ ...request, recoveryOnly })
  ).toThrow()
})
it('preserves and freezes exact cancellation confirmation', () => {
  const sourceCancellation = { canceled: true, sentEndSu: 20, creditedEndSu: 20 }
  const parsed = parsePtyOwnershipTransferSourceRetirementEvidence({
    ...evidence,
    sourceCancellation
  })
  expect(parsed.sourceCancellation).toEqual(sourceCancellation)
  expect(Object.isFrozen(parsed.sourceCancellation)).toBe(true)
})
it.each([
  null,
  {},
  [],
  { canceled: false, sentEndSu: 20, creditedEndSu: 20 },
  { canceled: true, sentEndSu: 21, creditedEndSu: 20 },
  { canceled: true, sentEndSu: 20, creditedEndSu: 19 }
])('rejects mismatched cancellation %j', (sourceCancellation) => {
  expect(() =>
    parsePtyOwnershipTransferSourceRetirementEvidence({ ...evidence, sourceCancellation })
  ).toThrow()
})
