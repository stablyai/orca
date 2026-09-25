import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import WebSocket from 'ws'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineStreamingMethod } from '../../src/main/runtime/rpc/core'
import {
  encodeTerminalStreamFrame,
  TerminalStreamOpcode
} from '../../src/shared/terminal-stream-protocol'
import type { RpcBinaryChannelOptions } from '../../mobile/src/transport/rpc-binary-channel'
import { DirectRpcClient, MobileBrowserTunnelConnection } from './mobile-browser-tunnel-clients'
import { BrowserNetworkTunnelDuplex } from '../../src/main/browser/browser-network-tunnel-duplex'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from '../../src/main/browser/browser-network-tunnel-outbound-memory-budget'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../../src/main/runtime/runtime-rpc'
import { ALL_RPC_METHODS } from '../../src/main/runtime/rpc/methods'
import { PairedRuntimeBrowserHostLease } from '../../src/main/browser/paired-runtime-browser-host-lease'
import { parsePairingCode } from '../../src/shared/pairing'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).toReversed()) {
    await close()
  }
  vi.unstubAllGlobals()
})

async function host(scope: 'runtime' | 'mobile') {
  vi.stubGlobal('WebSocket', WebSocket)
  const path = mkdtempSync(join(tmpdir(), 'mobile-tunnel-'))
  cleanup.push(() => rmSync(path, { recursive: true, force: true }))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these RPC tests do not invoke application service ports.
  const runtime = new OrcaRuntimeService({} as never)
  const terminalFrames: (() => void)[] = []
  const terminalMethod = defineStreamingMethod({
    name: 'terminal.subscribe',
    params: z.unknown(),
    handler: async (_params, { sendBinary, signal, registerBinaryStreamHandler }, emit) => {
      const release = registerBinaryStreamHandler?.(42, () => {})
      emit({ type: 'subscribed', streamId: 42 })
      terminalFrames.push(() =>
        sendBinary?.(
          encodeTerminalStreamFrame({
            opcode: TerminalStreamOpcode.Metadata,
            streamId: 42,
            seq: 1,
            payload: new TextEncoder().encode(JSON.stringify({ cwd: '/execution-host' }))
          })
        )
      )
      await new Promise<void>((resolve) =>
        signal?.addEventListener(
          'abort',
          () => {
            release?.()
            resolve()
          },
          { once: true }
        )
      )
    }
  })
  const rpc = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath: path,
    enableWebSocket: true,
    wsPort: 0,
    methods: [
      ...ALL_RPC_METHODS.filter((method) => method.name !== 'terminal.subscribe'),
      terminalMethod
    ]
  })
  await rpc.start()
  cleanup.push(() => rpc.stop())
  const offer = rpc.createPairingOffer({ name: 'transport-test', scope })
  if (!offer.available) {
    throw new Error('Pairing unavailable')
  }
  const pairing = parsePairingCode(offer.pairingUrl)
  if (!pairing) {
    throw new Error('Invalid pairing')
  }
  return { runtime, rpc, pairing, terminalFrames }
}

describe('mobile browser binary transport admission', () => {
  it('preserves the real runtime mobile allowlist denial as absent', async () => {
    const { runtime, pairing } = await host('mobile')
    const budget = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry().acquire('phone')
    if (!budget) {
      throw new Error('No budget')
    }
    cleanup.push(budget.release)
    const connection = new MobileBrowserTunnelConnection({
      attach: {
        authorityRuntimeId: runtime.getRuntimeId(),
        authorityEpoch: 'not-admitted',
        browserHostClientId: 'phone',
        browserHostGeneration: 1,
        executionHost: {
          kind: 'native',
          runtimeId: runtime.getRuntimeId(),
          revision: runtime.getStartedAt()
        }
      },
      connect: (binaryChannel) =>
        new DirectRpcClient(pairing.endpoint, pairing.deviceToken, pairing.publicKeyB64, {
          binaryChannel
        }),
      createSocket: (callbacks) => new BrowserNetworkTunnelDuplex(callbacks),
      outboundMemory: budget,
      minimumTunnelGeneration: 0
    })
    cleanup.push(() => connection.close())
    await expect(connection.ready).resolves.toBeNull()
  })
})

describe('mobile direct binary browser transport with authorized runtime credential', () => {
  it('uses one route for concurrent streams and closes them without affecting control', async () => {
    const { runtime, pairing, terminalFrames } = await host('runtime')
    const sockets = new Set<Socket>()
    const requests: string[] = []
    const destination = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('data', (bytes) => {
        requests.push(bytes.toString())
        socket.write(`execution-host:${bytes.toString()}`)
      })
    })
    await new Promise<void>((resolve) => destination.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => {
      for (const socket of sockets) {
        socket.destroy()
      }
      await new Promise<void>((resolve) => destination.close(() => resolve()))
    })
    const address = destination.address()
    if (!address || typeof address === 'string') {
      throw new Error('No destination address')
    }
    const hostLease = new PairedRuntimeBrowserHostLease({
      pairing,
      authorityRuntimeId: runtime.getRuntimeId(),
      browserHostClientId: 'phone',
      hostCapabilities: ['webview']
    })
    const lease = await hostLease.start()
    cleanup.push(() => hostLease.close())
    const control = new DirectRpcClient(
      pairing.endpoint,
      pairing.deviceToken,
      pairing.publicKeyB64,
      {}
    )
    cleanup.push(() => control.close())
    const terminalMetadata = vi.fn()
    control.subscribe('terminal.subscribe', { terminal: 'fixture' }, terminalMetadata)
    const budget = new BrowserNetworkTunnelOutboundMemoryBudgetRegistry().acquire('phone')
    if (!budget) {
      throw new Error('No budget')
    }
    cleanup.push(budget.release)
    const factory = vi.fn(
      (binaryChannel: RpcBinaryChannelOptions) =>
        new DirectRpcClient(pairing.endpoint, pairing.deviceToken, pairing.publicKeyB64, {
          binaryChannel
        })
    )
    const connection = new MobileBrowserTunnelConnection({
      attach: {
        ...lease,
        executionHost: {
          kind: 'native',
          runtimeId: runtime.getRuntimeId(),
          revision: runtime.getStartedAt()
        }
      },
      connect: factory,
      createSocket: (callbacks) => new BrowserNetworkTunnelDuplex(callbacks),
      outboundMemory: budget,
      minimumTunnelGeneration: 0
    })
    cleanup.push(() => connection.close())
    const tunnel = await connection.ready
    if (!tunnel) {
      throw new Error('Authorized test tunnel unavailable')
    }
    const target = { host: '127.0.0.1', port: address.port }
    const [first, second] = await Promise.all([tunnel.open(target), tunnel.open(target)])
    const replies: string[] = []
    for (const stream of [first, second]) {
      stream.on('data', (bytes: Buffer) => {
        replies.push(bytes.toString())
        stream.settleRead(bytes.length)
      })
    }
    await vi.waitFor(() => expect(terminalFrames).toHaveLength(1))
    terminalFrames[0]?.()
    first.write('first-marker')
    second.write('second-marker')
    await vi.waitFor(() =>
      expect(replies.sort()).toEqual([
        'execution-host:first-marker',
        'execution-host:second-marker'
      ])
    )
    expect(requests.sort()).toEqual(['first-marker', 'second-marker'])
    expect(factory).toHaveBeenCalledOnce()
    await expect(control.sendRequest('status.get')).resolves.toMatchObject({ ok: true })
    await vi.waitFor(() =>
      expect(terminalMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/execution-host' })
      )
    )
    const binaryClient = factory.mock.results[0]?.value
    expect(() => binaryClient?.subscribe('terminal.subscribe', {}, () => {})).toThrow(
      'Dedicated browser'
    )
    expect(control.sendBinary(new Uint8Array([1]))).toBe(false)
    expect(binaryClient?.sendBinary(new Uint8Array([1, 2, 3]))).toBe(true)
    await vi.waitFor(() => expect(sockets.size).toBe(0))
    connection.close()
    expect(first.destroyed).toBe(true)
    expect(second.destroyed).toBe(true)
    await expect(control.sendRequest('status.get')).resolves.toMatchObject({ ok: true })
    await expect(tunnel.open(target)).rejects.toThrow('closed')
    terminalMetadata.mockClear()
    terminalFrames[0]?.()
    await vi.waitFor(() =>
      expect(terminalMetadata).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/execution-host' })
      )
    )
    for (const invalid of [
      {
        ...lease,
        authorityEpoch: 'stale-epoch',
        executionHost: {
          kind: 'native' as const,
          runtimeId: runtime.getRuntimeId(),
          revision: runtime.getStartedAt()
        }
      },
      {
        ...lease,
        executionHost: {
          kind: 'native' as const,
          runtimeId: runtime.getRuntimeId(),
          revision: runtime.getStartedAt() - 1
        }
      }
    ]) {
      const stale = new MobileBrowserTunnelConnection({
        attach: invalid,
        connect: factory,
        createSocket: (callbacks) => new BrowserNetworkTunnelDuplex(callbacks),
        outboundMemory: budget,
        minimumTunnelGeneration: 0
      })
      cleanup.push(() => stale.close())
      await expect(stale.ready).rejects.toThrow()
      expect(sockets.size).toBe(0)
    }
    const replacement = new MobileBrowserTunnelConnection({
      attach: {
        ...lease,
        executionHost: {
          kind: 'native',
          runtimeId: runtime.getRuntimeId(),
          revision: runtime.getStartedAt()
        }
      },
      connect: factory,
      createSocket: (callbacks) => new BrowserNetworkTunnelDuplex(callbacks),
      outboundMemory: budget,
      minimumTunnelGeneration: tunnel.generation
    })
    cleanup.push(() => replacement.close())
    expect((await replacement.ready)?.generation).toBeGreaterThan(tunnel.generation)
    replacement.close()
  })
})
