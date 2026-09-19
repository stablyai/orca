import { describe, expect, it } from 'vitest'
import { PtyOwnershipTransferOutputCreditWindow } from './pty-ownership-transfer-output-credit'

describe('PtyOwnershipTransferOutputCreditWindow', () => {
  it('releases exact cumulative receiver credit and admits the queued tail', () => {
    const credit = new PtyOwnershipTransferOutputCreditWindow(6)

    expect(credit.admit({ seq: 3, data: 'four' })).toBe('accepted')
    expect(credit.admit({ seq: 4, data: 'to' })).toBe('accepted')
    expect(credit.admit({ seq: 5, data: 'x' })).toBe('capacity')
    expect(credit.acknowledge(3)).toEqual({
      throughSeq: 3,
      acknowledgedBytes: 4,
      inFlightBytes: 2
    })
    expect(credit.admit({ seq: 5, data: 'x' })).toBe('accepted')
    expect(credit.snapshot()).toEqual({ throughSeq: 3, inFlightBytes: 3, sentFrames: 2 })
  })

  it('keeps duplicate cumulative ACKs idempotent and rejects credit inflation', () => {
    const credit = new PtyOwnershipTransferOutputCreditWindow(8)
    credit.admit({ seq: 7, data: 'one' })

    expect(credit.acknowledge(7)).toEqual({
      throughSeq: 7,
      acknowledgedBytes: 3,
      inFlightBytes: 0
    })
    expect(credit.acknowledge(7)).toEqual({
      throughSeq: 7,
      acknowledgedBytes: 0,
      inFlightBytes: 0
    })
    expect(() => credit.acknowledge(8)).toThrow('pty_ownership_transfer_output_credit_ack_ahead')
    expect(() => credit.acknowledge(6)).toThrow('pty_ownership_transfer_output_credit_ack_invalid')
  })

  it('rejects conflicting duplicates and sequence gaps', () => {
    const credit = new PtyOwnershipTransferOutputCreditWindow(16)
    expect(credit.admit({ seq: 2, data: 'same' })).toBe('accepted')
    expect(credit.admit({ seq: 2, data: 'same' })).toBe('duplicate')
    expect(() => credit.admit({ seq: 2, data: 'changed' })).toThrow(
      'pty_ownership_transfer_output_credit_frame_conflict'
    )
    expect(() => credit.admit({ seq: 4, data: 'gap' })).toThrow(
      'pty_ownership_transfer_output_credit_sequence_gap'
    )
  })

  it('bounds in-flight frame count independently of byte credit', () => {
    const credit = new PtyOwnershipTransferOutputCreditWindow(16, 2)

    expect(credit.admit({ seq: 1, data: 'a' })).toBe('accepted')
    expect(credit.admit({ seq: 2, data: 'b' })).toBe('accepted')
    expect(credit.admit({ seq: 3, data: 'c' })).toBe('capacity')
    expect(credit.acknowledge(1)).toMatchObject({ inFlightBytes: 1 })
    expect(credit.admit({ seq: 3, data: 'c' })).toBe('accepted')
  })
})
