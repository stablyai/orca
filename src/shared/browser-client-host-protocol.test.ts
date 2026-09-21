import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES } from './remote-runtime-memory-limits'
import {
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES,
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_IDENTITY_MAX_JSON_BYTES,
  BROWSER_CLIENT_HOST_PAGE_INVENTORY_PROTOCOL_VERSION,
  BROWSER_CLIENT_HOST_LEASE_RECONNECT_PROTOCOL_VERSION,
  BrowserClientHostAttachParams,
  BrowserClientHostCommandEvent,
  BrowserClientHostCommandResultAck,
  BrowserClientHostCommandResultParams,
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

  it('negotiates a complete bounded page inventory independently of commands', () => {
    const page = {
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-old',
      browserHostClientId: 'host-a',
      browserHostGeneration: 2,
      browserPageId: 'page-a',
      pageHostGeneration: 3,
      browserProfileId: 'profile-a',
      executionHostKey: 'native:runtime-a:1',
      state: 'active' as const,
      currentUrl: 'https://remote.internal/'
    }
    const attach = BrowserClientHostAttachParams.parse({
      authorityRuntimeId: 'runtime-a',
      browserHostClientId: 'host-a',
      hostCapabilities: ['webview'],
      pageInventoryProtocolVersion: BROWSER_CLIENT_HOST_PAGE_INVENTORY_PROTOCOL_VERSION,
      pageInventory: [page]
    })

    expect(attach).toMatchObject({ pageInventoryProtocolVersion: 1, pageInventory: [page] })
    expect(
      BrowserClientHostReady.parse({
        type: 'ready',
        authorityEpoch: 'epoch-a',
        browserHostGeneration: 4,
        pageInventoryProtocolVersion: 1
      })
    ).toMatchObject({ pageInventoryProtocolVersion: 1 })
    expect(() =>
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        pageInventoryProtocolVersion: 1
      })
    ).toThrow()
    expect(() =>
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        pageInventory: [page]
      })
    ).toThrow()
    expect(() =>
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        pageInventoryProtocolVersion: 1,
        pageInventory: [page, page]
      })
    ).toThrow()
    expect(() =>
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        pageInventoryProtocolVersion: 1,
        pageInventory: Array.from({ length: 257 }, (_, index) => ({
          ...page,
          browserPageId: `page-${index}`
        }))
      })
    ).toThrow()
    expect(() =>
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        pageInventoryProtocolVersion: 1,
        pageInventory: Array.from({ length: 256 }, (_, index) => ({
          ...page,
          browserPageId: `page-${index}`,
          currentUrl: `https://remote.internal/${'x'.repeat(4096)}`
        }))
      })
    ).toThrow('Browser page inventory exceeds its byte budget')
    expect(BROWSER_CLIENT_HOST_PAGE_INVENTORY_MAX_BYTES).toBeLessThan(
      REMOTE_RUNTIME_MAX_SUBSCRIPTION_PARAM_BYTES
    )
    expect(() =>
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        pageInventoryProtocolVersion: 1,
        pageInventory: [{ ...page, browserHostClientId: 'host-b' }]
      })
    ).toThrow('Browser page inventory authority does not match the attaching host')
  })

  it('negotiates reconnect grace only with a complete inventory snapshot', () => {
    expect(
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        pageInventoryProtocolVersion: 1,
        pageInventory: [],
        leaseReconnectProtocolVersion: BROWSER_CLIENT_HOST_LEASE_RECONNECT_PROTOCOL_VERSION
      })
    ).toMatchObject({ leaseReconnectProtocolVersion: 1 })
    expect(
      BrowserClientHostReady.parse({
        type: 'ready',
        authorityEpoch: 'epoch-a',
        browserHostGeneration: 2,
        leaseReconnectProtocolVersion: 1
      })
    ).toMatchObject({ leaseReconnectProtocolVersion: 1 })
    expect(() =>
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        leaseReconnectProtocolVersion: 1
      })
    ).toThrow('Browser host reconnect requires page inventory negotiation')
  })

  it('bounds inventory identities after JSON escaping without narrowing legacy identities', () => {
    const authorityRuntimeId = maxInventoryIdentity('runtime-')
    const browserHostClientId = maxInventoryIdentity('host-')
    const pageInventory = Array.from({ length: 256 }, (_, index) => ({
      authorityRuntimeId,
      authorityEpoch: maxInventoryIdentity('epoch-'),
      browserHostClientId,
      browserHostGeneration: 2,
      browserPageId: maxInventoryIdentity(`page-${index.toString().padStart(3, '0')}-`),
      pageHostGeneration: 3,
      browserProfileId: maxInventoryIdentity('profile-'),
      executionHostKey: maxInventoryIdentity('execution-'),
      state: 'active' as const
    }))
    const firstPage = pageInventory.at(0)
    if (!firstPage) {
      throw new Error('expected inventory page')
    }

    expect(
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-new',
        browserHostClientId,
        hostCapabilities: ['webview'],
        pageInventoryProtocolVersion: 1,
        pageInventory
      }).pageInventory
    ).toHaveLength(256)
    expect(
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'é'.repeat(256),
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview']
      })
    ).toMatchObject({ authorityRuntimeId: 'é'.repeat(256) })
    expect(() =>
      BrowserClientHostAttachParams.parse({
        authorityRuntimeId: 'runtime-new',
        browserHostClientId,
        hostCapabilities: ['webview'],
        pageInventoryProtocolVersion: 1,
        pageInventory: [
          {
            ...firstPage,
            browserProfileId: `${maxInventoryIdentity('profile-')}x`
          }
        ]
      })
    ).toThrow('Browser page inventory identity exceeds its JSON byte budget')
  })

  it('keeps old attach and ready decoders compatible with optional inventory fields', () => {
    const legacyAttach = z.object({
      authorityRuntimeId: z.string(),
      browserHostClientId: z.string(),
      hostCapabilities: z.array(z.string()),
      pageCommandProtocolVersion: z.literal(1).optional()
    })
    const legacyReady = z.object({
      type: z.literal('ready'),
      authorityEpoch: z.string(),
      browserHostGeneration: z.number(),
      pageCommandProtocolVersion: z.literal(1).optional()
    })

    expect(
      legacyAttach.parse({
        authorityRuntimeId: 'runtime-a',
        browserHostClientId: 'host-a',
        hostCapabilities: ['webview'],
        pageInventoryProtocolVersion: 1,
        pageInventory: [],
        leaseReconnectProtocolVersion: 1
      })
    ).not.toHaveProperty('pageInventory')
    expect(
      legacyReady.parse({
        type: 'ready',
        authorityEpoch: 'epoch-a',
        browserHostGeneration: 2,
        pageInventoryProtocolVersion: 1,
        leaseReconnectProtocolVersion: 1
      })
    ).not.toHaveProperty('pageInventoryProtocolVersion')
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

    expect(
      BrowserNetworkTunnelAttachParams.parse({
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: 'epoch-a',
        browserHostClientId: 'client-a',
        browserHostGeneration: 1,
        executionHost: {
          kind: 'wsl',
          runtimeId: 'runtime-a',
          revision: 8,
          distro: 'Ubuntu'
        }
      }).executionHost
    ).toEqual({ kind: 'wsl', runtimeId: 'runtime-a', revision: 8, distro: 'Ubuntu' })
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

function maxInventoryIdentity(prefix: string): string {
  let value = prefix
  while (
    value.length < 256 &&
    jsonByteLength(`${value}\0`) <= BROWSER_CLIENT_HOST_PAGE_INVENTORY_IDENTITY_MAX_JSON_BYTES
  ) {
    value += '\0'
  }
  while (
    jsonByteLength(`${value}x`) <= BROWSER_CLIENT_HOST_PAGE_INVENTORY_IDENTITY_MAX_JSON_BYTES
  ) {
    value += 'x'
  }
  return value
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength
}
