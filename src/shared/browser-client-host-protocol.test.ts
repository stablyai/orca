import { describe, expect, it } from 'vitest'
import {
  BrowserClientHostAttachParams,
  BrowserClientHostEvent,
  BrowserClientHostReady,
  BrowserNetworkTunnelAttachParams,
  BrowserNetworkTunnelEvent
} from './browser-client-host-protocol'

describe('browser client-host control protocol', () => {
  it('decodes a bounded host attach and server-issued lease fence', () => {
    expect(
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview']
      })
    ).toEqual({
      authorityRuntimeId: 'runtime-a',
      browserHostClientId: 'host-a',
      hostCapabilities: ['webview']
    })
    expect(
      BrowserClientHostReady.parse({
        type: 'ready',
        authorityEpoch: 'epoch-a',
        browserHostGeneration: 2
      })
    ).toEqual({ type: 'ready', authorityEpoch: 'epoch-a', browserHostGeneration: 2 })
  })

  it('requires every lease and execution-host fence on tunnel attach', () => {
    expect(() =>
      BrowserNetworkTunnelAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        browserHostGeneration: 1,
        executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 1 }
      })
    ).toThrow()
    expect(
      BrowserNetworkTunnelAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'host-a',
        browserHostGeneration: 1,
        executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 1 }
      })
    ).toMatchObject({ authorityEpoch: 'epoch-a', browserHostGeneration: 1 })
  })

  it('rejects invalid server-owned route generations', () => {
    expect(() => BrowserNetworkTunnelEvent.parse({ type: 'ready', tunnelGeneration: 0 })).toThrow()
    expect(BrowserNetworkTunnelEvent.parse({ type: 'ready', tunnelGeneration: 3 })).toEqual({
      type: 'ready',
      tunnelGeneration: 3
    })
  })

  it('binds revocation to the exact authority and host generation', () => {
    expect(
      BrowserClientHostEvent.parse({
        type: 'revoked',
        authorityEpoch: 'epoch-a',
        browserHostGeneration: 3,
        reason: 'replaced'
      })
    ).toEqual({
      type: 'revoked',
      authorityEpoch: 'epoch-a',
      browserHostGeneration: 3,
      reason: 'replaced'
    })
  })
})
