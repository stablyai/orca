import { describe, expect, it, vi } from 'vitest'
import { probePairedRuntimePtyOwnershipTransferStatus } from './paired-runtime-pty-ownership-transfer-status-client'

const identity = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal:one',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 2,
  destinationRuntimeId: 'runtime-destination'
} as const

function statusResult() {
  return {
    ...identity,
    version: 1,
    phase: 'prepared',
    sourceOutputEndSeq: 4,
    replayStartSeq: 1,
    acceptedSourceEndSeq: 0,
    acceptedInputIds: 0
  }
}

describe('paired-runtime PTY ownership-transfer status client', () => {
  it('routes the exact local handle to its owner and parses the recovery snapshot', async () => {
    const callRuntimeRpc = vi.fn(async () => statusResult())

    await expect(
      probePairedRuntimePtyOwnershipTransferStatus(
        {
          ptyId: 'remote:env-1@@terminal%3Aone',
          identity,
          timeoutMs: 2_000
        },
        { callRuntimeRpc: callRuntimeRpc as never }
      )
    ).resolves.toEqual(statusResult())
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'pty.ownershipTransfer.statusSource',
      {
        ptyId: identity.terminalId,
        destinationRuntimeId: identity.destinationRuntimeId,
        identity,
        timeoutMs: 2_000
      },
      { timeoutMs: 2_000, signal: undefined }
    )
  })

  it('returns unavailable for an older owner without converting contact loss into status', async () => {
    const unavailable = await probePairedRuntimePtyOwnershipTransferStatus(
      { ptyId: 'remote:env-old@@terminal%3Aone', identity },
      {
        callRuntimeRpc: (() => {
          throw { code: 'method_not_found', message: 'Unknown method' }
        }) as never
      }
    )
    expect(unavailable).toBeNull()

    await expect(
      probePairedRuntimePtyOwnershipTransferStatus(
        { ptyId: 'remote:env-offline@@terminal%3Aone', identity },
        {
          callRuntimeRpc: (() => {
            throw new Error('transport unavailable')
          }) as never
        }
      )
    ).rejects.toThrow('transport unavailable')
  })

  it('rejects an unscoped or mismatched source before contacting a runtime', async () => {
    const callRuntimeRpc = vi.fn()

    await expect(
      probePairedRuntimePtyOwnershipTransferStatus(
        { ptyId: 'remote:terminal%3Aone', identity },
        { callRuntimeRpc: callRuntimeRpc as never }
      )
    ).rejects.toThrow('pty_ownership_transfer_paired_source_identity_invalid')
    await expect(
      probePairedRuntimePtyOwnershipTransferStatus(
        {
          ptyId: 'remote:env-1@@another-terminal',
          identity
        },
        { callRuntimeRpc: callRuntimeRpc as never }
      )
    ).rejects.toThrow('pty_ownership_transfer_paired_source_identity_invalid')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('rejects a validly shaped status response for another bridge', async () => {
    await expect(
      probePairedRuntimePtyOwnershipTransferStatus(
        { ptyId: 'remote:env-1@@terminal%3Aone', identity },
        {
          callRuntimeRpc: (async () => ({ ...statusResult(), bridgeId: 'another-bridge' })) as never
        }
      )
    ).rejects.toThrow('pty_ownership_transfer_response_identity_mismatch')
  })
})
