import { describe, expect, it, vi } from 'vitest'
import { PairedRuntimePtyOwnershipTransferClient } from './paired-runtime-pty-ownership-transfer-client'

const identity = {
  bridgeId: 'bridge-1',
  terminalId: 'terminal:one',
  incarnationId: 'incarnation-1',
  ownerLease: 'lease-1',
  sourceOwnerGeneration: 2,
  destinationRuntimeId: 'runtime-destination'
} as const

const dormantCapabilities = {
  protocolVersions: [1],
  maxReplayBytes: 128 * 1024,
  maxInputIds: 4096,
  inputDeduplication: true,
  rollback: true,
  liveTransfer: false,
  statusQuery: true
} as const

function dormantPreflight() {
  return {
    topology: 'runtime-owned',
    transferSupported: false,
    statusQuerySupported: true,
    blocker: 'live-transfer-disabled',
    capabilities: dormantCapabilities
  }
}

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

function client(callRuntimeRpc: ReturnType<typeof vi.fn>) {
  return new PairedRuntimePtyOwnershipTransferClient(
    'remote:env-1@@terminal%3Aone',
    identity.destinationRuntimeId,
    { callRuntimeRpc: callRuntimeRpc as never }
  )
}

describe('PairedRuntimePtyOwnershipTransferClient', () => {
  it('strictly decodes a dormant source capability probe', async () => {
    const callRuntimeRpc = vi.fn(async () => dormantPreflight())

    await expect(client(callRuntimeRpc).preflight()).resolves.toEqual({
      ...dormantPreflight(),
      topology: 'paired-runtime-reference'
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'pty.ownershipTransfer.preflightSource',
      { ptyId: identity.terminalId, destinationRuntimeId: identity.destinationRuntimeId },
      { timeoutMs: 5_000, signal: undefined }
    )
  })

  it.each([
    ['partial capabilities', { ...dormantPreflight(), capabilities: { liveTransfer: false } }],
    ['unknown blocker', { ...dormantPreflight(), blocker: 'maybe-later' }],
    ['false success', { ...dormantPreflight(), transferSupported: true }],
    ['wrong topology', { ...dormantPreflight(), topology: 'direct-ssh' }]
  ])('rejects a malformed %s response', async (_label, response) => {
    const callRuntimeRpc = vi.fn(async () => response)

    await expect(client(callRuntimeRpc).preflight()).rejects.toThrow(
      /pty_ownership_transfer_(?:preflight_result_invalid|preflight_topology_mismatch)/
    )
  })

  it('maps only an old-host method absence to a fail-closed result', async () => {
    const absent = client(
      vi.fn(async () => {
        throw { code: 'method_not_found', message: 'Unknown method: preflight' }
      })
    )
    await expect(absent.preflight()).resolves.toMatchObject({
      transferSupported: false,
      statusQuerySupported: false,
      blocker: 'source-capabilities-unavailable',
      capabilities: null
    })

    const offline = client(
      vi.fn(async () => {
        throw new Error('transport unavailable')
      })
    )
    await expect(offline.preflight()).rejects.toThrow('transport unavailable')
  })

  it('strictly decodes status and fences the exact source identity', async () => {
    const callRuntimeRpc = vi.fn(async () => statusResult())

    await expect(client(callRuntimeRpc).status(identity, { timeoutMs: 2_000 })).resolves.toEqual(
      statusResult()
    )
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

    await expect(
      client(vi.fn(async () => ({ ...statusResult(), bridgeId: 'other-bridge' }))).status(identity)
    ).rejects.toThrow('pty_ownership_transfer_response_identity_mismatch')
  })

  it('rejects a mismatched handle before contacting the owner', async () => {
    const callRuntimeRpc = vi.fn()
    await expect(
      client(callRuntimeRpc).status({ ...identity, terminalId: 'another-terminal' })
    ).rejects.toThrow('pty_ownership_transfer_paired_source_identity_invalid')
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('rejects malformed constructor identities before parsing or contacting the owner', () => {
    expect(
      () =>
        new PairedRuntimePtyOwnershipTransferClient(
          42 as never,
          identity.destinationRuntimeId,
          { callRuntimeRpc: vi.fn() as never }
        )
    ).toThrow('pty_ownership_transfer_paired_source_identity_invalid')
    expect(
      () =>
        new PairedRuntimePtyOwnershipTransferClient(
          'remote:env-1@@terminal%3Aone',
          '   ',
          { callRuntimeRpc: vi.fn() as never }
        )
    ).toThrow('pty_ownership_transfer_paired_source_identity_invalid')
  })
})
