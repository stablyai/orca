import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, connect, type Socket } from 'node:net'
import WebSocket from 'ws'
import nacl from 'tweetnacl'
import { z } from 'zod'
import { afterEach, expect, it, vi } from 'vitest'
import { DeviceRegistry } from '../../src/main/runtime/device-registry'
import { MobileSocketWiring } from '../../src/main/runtime/rpc/mobile-socket-wiring'
import { BrowserNetworkTunnelSession } from '../../src/main/browser/browser-network-tunnel-session'
import { BrowserNetworkTunnelDuplex } from '../../src/main/browser/browser-network-tunnel-duplex'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from '../../src/main/browser/browser-network-tunnel-outbound-memory-budget'
import { deriveRelayHostId } from '../../src/main/runtime/relay/relay-http-client'
import {
  connectMobileRelayRpcSession,
  MobileBrowserTunnelConnection
} from './mobile-browser-tunnel-clients'
import { browserRelaySplice } from './mobile-browser-relay-splice'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../src/shared/terminal-stream-protocol'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllGlobals()
})

it('carries real mobile relay E2EE binary tunnel and terminal traffic on separate sockets', async () => {
  vi.stubGlobal('WebSocket', WebSocket)
  const path = mkdtempSync(join(tmpdir(), 'mobile-browser-relay-'))
  cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  const devices = new DeviceRegistry(path)
  // Transport-only admission fixture: production still refuses mobile browser tunnels.
  const device = devices.addDevice('authorized transport test', 'runtime')
  const keys = nacl.box.keyPair()
  const relayHostId = deriveRelayHostId(keys.publicKey)
  const splice = await browserRelaySplice(relayHostId, device.deviceId)
  cleanup.push(splice.close)
  const relay = {
    v: 1 as const,
    directorUrl: 'https://relay.test',
    cellUrl: splice.origin.replace('http:', 'https:'),
    assignmentEpoch: 1,
    relayHostId,
    e2eeFraming: 2 as const
  }
  const destinations = new Set<Socket>()
  const received: string[] = []
  const target = createServer((socket) => {
    destinations.add(socket)
    socket.once('close', () => destinations.delete(socket))
    socket.on('data', (bytes) => {
      received.push(bytes.toString())
      socket.write('host-response')
    })
  })
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    for (const socket of destinations) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => target.close(() => resolve()))
  })
  const address = target.address()
  if (!address || typeof address === 'string') {
    throw new Error('No destination address')
  }
  const sessions = new Map<string, BrowserNetworkTunnelSession>()
  const attach = {
    authorityRuntimeId: 'fixture-runtime',
    authorityEpoch: 'fixture-epoch',
    browserHostClientId: 'phone',
    browserHostGeneration: 1,
    executionHost: { kind: 'native' as const, runtimeId: 'fixture-runtime', revision: 1 }
  }
  const terminalSenders: (() => void)[] = []
  const wiring = new MobileSocketWiring({
    deviceRegistry: devices,
    e2eeKeypair: { ...keys, publicKeyB64: Buffer.from(keys.publicKey).toString('base64') },
    onText: (socket, text, reply, sendBinary) => {
      const request = z
        .object({ id: z.string(), method: z.string(), params: z.unknown().optional() })
        .parse(JSON.parse(text))
      const respond = (result: unknown, streaming = false) =>
        reply(
          JSON.stringify({
            id: request.id,
            ok: true,
            result,
            ...(streaming ? { streaming: true } : {}),
            _meta: { runtimeId: 'fixture-runtime' }
          })
        )
      if (request.method === 'network.browserTunnel') {
        expect(socket.device.scope).toBe('runtime')
        expect(request.params).toEqual(attach)
        const session = new BrowserNetworkTunnelSession({
          tunnelGeneration: 1,
          connect: (destination) => connect(destination),
          sendBinary: (bytes) => sendBinary(bytes) !== false
        })
        sessions.set(socket.connectionId, session)
        respond({ type: 'ready', tunnelGeneration: 1 }, true)
      } else if (request.method === 'terminal.subscribe') {
        respond({ type: 'subscribed', streamId: 42 }, true)
        terminalSenders.push(() =>
          sendBinary(
            encodeTerminalStreamFrame({
              opcode: TerminalStreamOpcode.Metadata,
              streamId: 42,
              seq: 1,
              payload: new TextEncoder().encode(JSON.stringify({ cwd: '/execution-host' }))
            })
          )
        )
      } else if (request.method === 'pairing.getEndpoints') {
        respond({
          v: 1,
          relay,
          resumeConfirmation: {
            v: 1,
            reqId: 'confirm',
            currentVersion: 1,
            acceptedAs: 'current',
            renewed: true,
            resumeExpiresAt: Date.now() + 300_000
          }
        })
      } else {
        respond({})
      }
    },
    onBinary: (socket, bytes) => sessions.get(socket.connectionId)?.handleBinary(bytes),
    onClose: (socket) => {
      if (socket) {
        sessions.get(socket.connectionId)?.close()
        sessions.delete(socket.connectionId)
      }
    }
  })
  wiring.attachTransport(splice.transport, (socket) => splice.transport.metadataFor(socket))
  const options = {
    relay,
    resumeToken: 'B'.repeat(43),
    resumeCredentialVersion: 1,
    resumeConfirmReqId: 'confirm',
    deviceToken: device.token,
    desktopPublicKeyB64: Buffer.from(keys.publicKey).toString('base64'),
    createSocket: (url: string) => new globalThis.WebSocket(url.replace('wss:', 'ws:'))
  }
  const terminal = connectMobileRelayRpcSession(options)
  cleanup.push(() => terminal.close())
  const metadata = vi.fn()
  terminal.subscribe('terminal.subscribe', { terminal: 'fixture' }, metadata)
  const memory = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry().acquire('phone')
  if (!memory) {
    throw new Error('No memory budget')
  }
  cleanup.push(memory.release)
  const connection = new MobileBrowserTunnelConnection({
    attach,
    connect: (binaryChannel) => connectMobileRelayRpcSession({ ...options, binaryChannel }),
    createSocket: (callbacks) => new BrowserNetworkTunnelDuplex(callbacks),
    outboundMemory: memory,
    minimumTunnelGeneration: 0
  })
  cleanup.push(() => connection.close())
  const tunnel = await connection.ready
  if (!tunnel) {
    throw new Error('Fixture transport not ready')
  }
  const stream = await tunnel.open({ host: '127.0.0.1', port: address.port })
  const delivered: string[] = []
  stream.on('data', (bytes: Buffer) => {
    delivered.push(bytes.toString())
    stream.settleRead(bytes.length)
  })
  stream.write('relay-request-marker')
  await vi.waitFor(() => expect(terminalSenders).toHaveLength(1))
  terminalSenders[0]?.()
  await vi.waitFor(() => expect(delivered).toEqual(['host-response']))
  await vi.waitFor(() =>
    expect(metadata).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'metadata', cwd: '/execution-host' })
    )
  )
  expect(received).toEqual(['relay-request-marker'])
  expect(splice.connectionCount()).toBe(2)
  connection.close()
  await vi.waitFor(() => expect(destinations.size).toBe(0))
  expect(terminal.getState()).toBe('connected')
  expect(sessions.size).toBe(0)
})
