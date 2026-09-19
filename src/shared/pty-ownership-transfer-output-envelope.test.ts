import { describe, expect, it } from 'vitest'
import {
  parsePtyOwnershipTransferOutputEnvelope,
  type PtyOwnershipTransferOutputEnvelope
} from './pty-ownership-transfer-output-envelope'

const identity = {
  bridgeId: 'bridge-1',
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 3,
  destinationRuntimeId: 'runtime-1'
} as const

function envelope(overrides: Partial<PtyOwnershipTransferOutputEnvelope> = {}) {
  return {
    ...identity,
    version: 1 as const,
    frameSeq: 7,
    fragmentStartSu: 0,
    fragmentEndSu: 4,
    frameLengthSu: 4,
    ...overrides
  }
}

describe('PTY ownership-transfer output envelope', () => {
  it('parses and freezes a valid envelope', () => {
    const parsed = parsePtyOwnershipTransferOutputEnvelope(envelope(), 'test')
    expect(parsed).toEqual(envelope())
    expect(Object.isFrozen(parsed)).toBe(true)
  })

  it.each([
    ['wrong version', envelope({ version: 2 as never }), 'version_invalid'],
    ['reversed range', envelope({ fragmentStartSu: 4, fragmentEndSu: 2 }), 'range_invalid'],
    ['past frame end', envelope({ fragmentEndSu: 5 }), 'range_invalid'],
    ['data length mismatch', envelope({ fragmentEndSu: 3 }), 'range_invalid'],
    ['missing bridge identity', envelope({ bridgeId: '' }), 'bridgeId_invalid']
  ])('rejects %s', (_name, value, reason) => {
    expect(() => parsePtyOwnershipTransferOutputEnvelope(value, 'test')).toThrow(reason)
  })

  it('keeps surrogate-pair fragments measured in UTF-16 units', () => {
    const parsed = parsePtyOwnershipTransferOutputEnvelope(
      envelope({ fragmentEndSu: 2, frameLengthSu: 2 }),
      '😀'
    )
    expect(parsed?.fragmentEndSu).toBe(2)
  })
})
