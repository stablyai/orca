import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))
import type * as RuntimeRpcClient from './runtime-rpc-client'

vi.mock('./runtime-rpc-client', async (importOriginal) => {
  const actual = await importOriginal<typeof RuntimeRpcClient>()
  return { ...actual, callRuntimeRpc }
})

import { preflightPairedRuntimePtyOwnershipTransfer } from './pty-ownership-transfer-source-preflight-client'

describe('paired-runtime PTY ownership-transfer preflight client', () => {
  beforeEach(() => callRuntimeRpc.mockReset())

  it('routes the host-local handle to its owning paired runtime', async () => {
    callRuntimeRpc.mockResolvedValue({
      topology: 'runtime-owned',
      transferSupported: false,
      statusQuerySupported: false,
      blocker: 'live-transfer-disabled',
      capabilities: {
        protocolVersions: [1],
        maxReplayBytes: 128 * 1024,
        maxInputIds: 4096,
        inputDeduplication: true,
        rollback: true,
        liveTransfer: false
      }
    })

    await expect(
      preflightPairedRuntimePtyOwnershipTransfer({
        ptyId: 'remote:env-1@@terminal%3Aone',
        destinationRuntimeId: 'runtime-destination'
      })
    ).resolves.toMatchObject({
      topology: 'paired-runtime-reference',
      transferSupported: false,
      blocker: 'live-transfer-disabled'
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'pty.ownershipTransfer.preflightSource',
      { ptyId: 'terminal:one', destinationRuntimeId: 'runtime-destination' },
      { timeoutMs: 5_000, signal: undefined }
    )
  })

  it('fails closed when an older paired runtime lacks the additive method', async () => {
    const result = await preflightPairedRuntimePtyOwnershipTransfer(
      {
        ptyId: 'remote:env-old@@terminal-1',
        destinationRuntimeId: 'runtime-destination'
      },
      {
        callRuntimeRpc: () => {
          throw { code: 'method_not_found', message: 'Unknown method' }
        }
      }
    )
    expect(result).toEqual({
      topology: 'paired-runtime-reference',
      transferSupported: false,
      statusQuerySupported: false,
      blocker: 'source-capabilities-unavailable',
      capabilities: null
    })
  })

  it.each(['local-pty', 'remote:terminal-without-owner'])(
    'rejects unowned source id %s',
    async (ptyId) => {
      await expect(
        preflightPairedRuntimePtyOwnershipTransfer({
          ptyId,
          destinationRuntimeId: 'runtime-destination'
        })
      ).rejects.toThrow('pty_ownership_transfer_paired_source_identity_invalid')
      expect(callRuntimeRpc).not.toHaveBeenCalled()
    }
  )
})
