import { describe, expect, it } from 'vitest'
import {
  parsePtyOwnershipTransferReconnectRekeyRequest,
  parsePtyOwnershipTransferReconnectRekeyResult
} from './pty-ownership-transfer-reconnect-rekey-wire'

const identity = {
  bridgeId: 'bridge-1',
  terminalId: 'pty-1',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 4,
  destinationRuntimeId: 'runtime-1'
} as const

const request = {
  ...identity,
  version: 1 as const,
  previousReconnectGeneration: 4,
  reconnectGeneration: 7,
  attachmentId: 'attachment-7'
}

describe('PTY ownership-transfer reconnect rekey wire', () => {
  it('keeps durable transfer identity stable while advancing the route generation', () => {
    expect(parsePtyOwnershipTransferReconnectRekeyRequest(request)).toEqual(request)
    expect(
      parsePtyOwnershipTransferReconnectRekeyResult({
        ...request,
        phase: 'committed',
        executionVerdict: 'live'
      })
    ).toEqual({ ...request, phase: 'committed', executionVerdict: 'live' })
  })

  it.each([
    { previousReconnectGeneration: 3, reconnectGeneration: 7 },
    { previousReconnectGeneration: 4, reconnectGeneration: 4 },
    { previousReconnectGeneration: 7, reconnectGeneration: 6 },
    { previousReconnectGeneration: 4, reconnectGeneration: Number.MAX_SAFE_INTEGER + 1 }
  ])('rejects a non-monotonic reconnect generation: %o', (generations) => {
    expect(() =>
      parsePtyOwnershipTransferReconnectRekeyRequest({ ...request, ...generations })
    ).toThrow('pty_ownership_transfer_reconnect_rekey_generation_invalid')
  })

  it('rejects a prepared result because rekey cannot continue an uncommitted transfer', () => {
    expect(() =>
      parsePtyOwnershipTransferReconnectRekeyResult({ ...request, phase: 'prepared' })
    ).toThrow('pty_ownership_transfer_reconnect_rekey_phase_invalid')
  })

  it('rejects an empty attachment fence', () => {
    expect(() =>
      parsePtyOwnershipTransferReconnectRekeyRequest({ ...request, attachmentId: '' })
    ).toThrow('pty_ownership_transfer_reconnect_rekey_attachment_invalid')
  })
})
