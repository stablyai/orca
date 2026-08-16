import { describe, expect, it } from 'vitest'
import {
  BrowserClientHostAttachParams,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResultAck,
  BrowserClientHostCommandResultParams,
  BrowserClientHostEvent,
  BrowserClientHostLeaseEvent,
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

  it('negotiates page commands independently of the legacy lease stream', () => {
    expect(
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        pageCommandProtocolVersion: 1
      })
    ).toMatchObject({ pageCommandProtocolVersion: 1 })
    expect(
      BrowserClientHostReady.parse({
        type: 'ready',
        authorityEpoch: 'epoch-a',
        browserHostGeneration: 2,
        pageCommandProtocolVersion: 1
      })
    ).toMatchObject({ pageCommandProtocolVersion: 1 })
    expect(
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview']
      })
    ).not.toHaveProperty('pageCommandProtocolVersion')
  })

  it('binds create-page commands and results to exact bounded authority', () => {
    const authority = {
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 2,
      browserPageId: 'page-a',
      pageHostGeneration: 3
    }
    const command = {
      type: 'command' as const,
      pageCommandProtocolVersion: 1 as const,
      ...authority,
      commandSequence: 4,
      commandId: 'command-a',
      command: {
        type: 'createPage' as const,
        browserProfileId: 'default',
        executionHostKey: 'native:runtime-a:5'
      }
    }

    expect(BrowserClientHostCommandEvent.parse(command)).toEqual(command)
    expect(BrowserClientHostEvent.parse(command)).toEqual(command)
    expect(() => BrowserClientHostLeaseEvent.parse(command)).toThrow()
    expect(
      BrowserClientHostCommandEvent.parse({
        ...command,
        commandSequence: 5,
        commandId: 'command-b',
        command: { type: 'navigate', url: 'https://remote.internal/path' }
      })
    ).toMatchObject({ command: { type: 'navigate', url: 'https://remote.internal/path' } })
    expect(
      BrowserClientHostCommandResultParams.parse({
        pageCommandProtocolVersion: 1,
        ...authority,
        commandSequence: 4,
        commandId: 'command-a',
        result: { status: 'completed' }
      })
    ).toMatchObject({ result: { status: 'completed' } })
    expect(BrowserClientHostCommandResultAck.parse({ accepted: false })).toEqual({
      accepted: false
    })
    expect(() => BrowserClientHostCommandResultAck.parse({ accepted: 'yes' })).toThrow()
  })

  it.each([
    ['zero sequence', { commandSequence: 0 }],
    ['wrong protocol', { pageCommandProtocolVersion: 2 }],
    ['empty command id', { commandId: '' }],
    ['unknown command', { command: { type: 'openAnything' } }],
    ['oversized navigation', { command: { type: 'navigate', url: `https://${'x'.repeat(8192)}` } }],
    [
      'oversized profile',
      {
        command: {
          type: 'createPage',
          browserProfileId: 'x'.repeat(257),
          executionHostKey: 'native:runtime-a:1'
        }
      }
    ]
  ])('rejects %s before page-command delivery', (_name, override) => {
    expect(() =>
      BrowserClientHostCommandEvent.parse({
        type: 'command',
        pageCommandProtocolVersion: 1,
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'host-a',
        browserHostGeneration: 2,
        browserPageId: 'page-a',
        pageHostGeneration: 3,
        commandSequence: 4,
        commandId: 'command-a',
        command: {
          type: 'createPage',
          browserProfileId: 'default',
          executionHostKey: 'native:runtime-a:5'
        },
        ...override
      })
    ).toThrow()
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

  it('decodes an exact SSH provider authority without changing native v1 attaches', () => {
    const authority = {
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'host-a',
      browserHostGeneration: 1
    }
    expect(
      BrowserNetworkTunnelAttachParams.parse({
        ...authority,
        executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 1 }
      })
    ).toEqual({
      ...authority,
      executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 1 }
    })
    expect(
      BrowserNetworkTunnelAttachParams.parse({
        ...authority,
        executionHost: {
          kind: 'ssh',
          targetId: 'target-a',
          providerEpoch: 'provider-epoch-a',
          connectionGeneration: 2
        }
      })
    ).toEqual({
      ...authority,
      executionHost: {
        kind: 'ssh',
        targetId: 'target-a',
        providerEpoch: 'provider-epoch-a',
        connectionGeneration: 2
      }
    })
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
