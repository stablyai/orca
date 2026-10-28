import {
  pairedRuntimeConnectionFromOffer,
  type PairedRuntimeConnection
} from '../../paired-runtime-connection'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { encodePairingOffer, parsePairingCode } from '../../pairing'
import {
  decrypt,
  deriveSharedKey,
  encrypt,
  generateKeyPair,
  publicKeyFromBase64,
  publicKeyToBase64
} from '../../e2ee-crypto'
import { RemoteRuntimeRequestConnection } from './remote-runtime-request-connection'
import { remoteRuntimeClientCapabilities } from '../remote-runtime-client-capabilities'
import { createFakeSpawnedChild } from '../../__fixtures__/fake-spawned-child'
import * as commandResolution from '../../../main/git/command-runner/git-command-resolution'
import * as gitRunner from '../../../main/git/runner'
import {
  acquireGitAdmission,
  GitAdmissionScheduler,
  _gitAdmissionSnapshotForTests,
  _resetGitAdmissionForTests
} from '../../../main/git/command-runner/git-subprocess-admission'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))
vi.mock('node:child_process', async (original) => ({
  ...(await original()),
  execFile: execFileMock
}))
import { getRemoteFileUrl } from '../../../main/git/repo'

type TestServer = {
  wss: WebSocketServer
  pairing: PairedRuntimeConnection
  requests: unknown[]
  auths: unknown[]
  connectionCount: () => number
}

const servers: WebSocketServer[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          for (const client of server.clients) {
            client.close()
          }
          server.close(() => resolve())
        })
    )
  )
})

describe('RemoteRuntimeRequestConnection', () => {
  async function reuseWithCancellation(wait: 'admission' | 'preflight') {
    _resetGitAdmissionForTests(new GitAdmissionScheduler({ generalCap: 1, generalHeadroom: 0 }))
    const exec = vi.spyOn(gitRunner, 'gitExecFileAsync')
    const metadata = [
      'origin\thttps://github.com/org/repo.git (fetch)',
      'remote.origin.fetch\n+refs/heads/*:refs/remotes/origin/*\0',
      'a'.repeat(40),
      'refs/heads/local',
      'refs/heads/local\0\0origin\0refs/heads/review/topic\0refs/remotes/origin/topic',
      'refs/remotes/origin/topic\0\0\0\0'
    ]
    const routing = { wslDistro: 'Ubuntu', admissionTier: 'interactive' } as const
    let holding: ReturnType<typeof acquireGitAdmission> | undefined
    const { promise: heldPreflight, resolve: releasePreflight } = Promise.withResolvers<void>()
    const preflight = vi
      .spyOn(commandResolution, 'pendingWslDirectGitReadEnvironment')
      .mockImplementation((args, options) => {
        expect(options).toMatchObject(routing)
        expect(options.timeout).toBeLessThanOrEqual(5_000)
        return wait === 'preflight' && args.some((arg: string) => arg.startsWith('--contains='))
          ? heldPreflight
          : null
      })
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      const child = createFakeSpawnedChild()
      queueMicrotask(() => {
        const stdout = metadata.shift() ?? ''
        if (!metadata.length && wait === 'admission') {
          holding = acquireGitAdmission({ args: ['status'], cwd: '/copy-blocker' })
        }
        callback(null, stdout, '')
        child.emit('close', 0, null)
      })
      return child
    })
    const server = await createServer(() => getRemoteFileUrl('/repo', 'a.ts', 10, 20, routing))
    const connection = new RemoteRuntimeRequestConnection(server.pairing)
    // ast-grep-ignore: test-no-wall-clock -- Measures the real encrypted RPC cancellation deadline.
    const start = Date.now()
    onTestFinished(async () => {
      connection.close()
      ;(await holding)?.release()
      releasePreflight()
      preflight.mockRestore()
      execFileMock.mockReset()
      exec.mockRestore()
      _resetGitAdmissionForTests()
    })
    const response = connection.request('git.remoteFileUrl', {}, 15_000)
    await vi.waitFor(() => expect(preflight).toHaveBeenCalledTimes(7))
    const optional = preflight.mock.calls.at(-1)
    expect(optional?.[0]).toContain(`--contains=${'a'.repeat(40)}`)
    if (wait === 'admission') {
      expect(_gitAdmissionSnapshotForTests().queuedWaiters).toMatchObject([{ args: optional?.[0] }])
    }
    await expect(response).resolves.toMatchObject({
      ok: true,
      result: 'https://github.com/org/repo/blob/review%2Ftopic/a.ts#L10-L20'
    })
    // ast-grep-ignore: test-no-wall-clock -- The production cancellation timer must actually elapse.
    expect(Date.now() - start).toBeGreaterThanOrEqual(5_000)
    // ast-grep-ignore: test-no-wall-clock -- The fallback must arrive before the real RPC deadline.
    expect(Date.now() - start).toBeLessThan(15_000)
    expect(optional?.[1].signal?.aborted).toBe(true)
    ;(await holding)?.release()
    releasePreflight()
    await expect(exec.mock.results.at(-1)?.value).rejects.toMatchObject({ name: 'AbortError' })
    expect(execFileMock).toHaveBeenCalledTimes(6)
    expect(_gitAdmissionSnapshotForTests().queued).toBe(0)
    expect(_gitAdmissionSnapshotForTests().budgets.general?.baseUsed).toBe(0)
    const second = await connection.request('terminal.send', { terminal: 't1', text: 'ab' }, 1000)

    expect(second).toMatchObject({
      ok: true,
      result: { method: 'terminal.send' },
      _meta: { runtimeId: 'runtime-test' }
    })
    expect(server.connectionCount()).toBe(1)
    expect(server.auths).toContainEqual(
      expect.objectContaining({
        clientCapabilities: remoteRuntimeClientCapabilities()
      })
    )
    expect(server.requests).toMatchObject([
      { method: 'git.remoteFileUrl', params: {} },
      { method: 'terminal.send', params: { terminal: 't1', text: 'ab' } }
    ])
  }
  it.each(['admission', 'preflight'] as const)(
    'cancels optional %s without late spawn and reuses the encrypted connection',
    reuseWithCancellation
  )

  it('aborts one request without closing the cached connection', async () => {
    const server = await createServer()
    const connection = new RemoteRuntimeRequestConnection(server.pairing)
    const controller = new AbortController()
    const pending = connection.request('test.hang', undefined, 60_000, controller.signal)
    await vi.waitFor(() =>
      expect(server.requests).toContainEqual(expect.objectContaining({ method: 'test.hang' }))
    )

    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(
      (connection as unknown as { pendingRequests: Map<string, unknown> }).pendingRequests.size
    ).toBe(0)
    await expect(connection.request('status.get', undefined, 1000)).resolves.toMatchObject({
      ok: true,
      result: { method: 'status.get' }
    })
    expect(server.connectionCount()).toBe(1)

    connection.close()
  })
})

async function createServer(reply?: () => Promise<unknown>): Promise<TestServer> {
  const serverKeyPair = generateKeyPair()
  const requests: unknown[] = []
  const auths: unknown[] = []
  let connectionCount = 0
  // host must match the 127.0.0.1 clients dial: a wildcard bind lets a foreign loopback listener claim the port and answer here.
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  servers.push(wss)

  wss.on('connection', (ws) => {
    connectionCount += 1
    let sharedKey: Uint8Array | null = null
    let authenticated = false

    ws.on('message', async (data, isBinary) => {
      if (isBinary) {
        return
      }
      const frame = data.toString()
      if (!sharedKey) {
        const hello = JSON.parse(frame) as { type: string; publicKeyB64: string }
        const clientPublicKey = publicKeyFromBase64(hello.publicKeyB64)
        sharedKey = deriveSharedKey(serverKeyPair.secretKey, clientPublicKey)
        ws.send(JSON.stringify({ type: 'e2ee_ready' }))
        return
      }

      const plaintext = decrypt(frame, sharedKey)
      if (plaintext === null) {
        return
      }
      if (!authenticated) {
        const auth = JSON.parse(plaintext) as { type: string; deviceToken: string }
        auths.push(auth)
        expect(auth).toEqual({
          type: 'e2ee_auth',
          deviceToken: 'device-token',
          clientCapabilities: remoteRuntimeClientCapabilities()
        })
        authenticated = true
        sendEncrypted(ws, sharedKey, { type: 'e2ee_authenticated' })
        return
      }

      const request = JSON.parse(plaintext) as {
        id: string
        method: string
        params?: unknown
      }
      requests.push(request)
      if (request.method === 'test.hang') {
        return
      }
      sendEncrypted(ws, sharedKey, {
        id: request.id,
        ok: true,
        result:
          reply && request.method === 'git.remoteFileUrl'
            ? await reply()
            : { method: request.method },
        _meta: { runtimeId: 'runtime-test' }
      })
    })
  })

  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address() as AddressInfo
  const pairing = parsePairingCode(
    encodePairingOffer({
      v: 2,
      endpoint: `ws://127.0.0.1:${address.port}`,
      deviceToken: 'device-token',
      publicKeyB64: publicKeyToBase64(serverKeyPair.publicKey)
    })
  )
  if (!pairing) {
    throw new Error('Failed to create test pairing')
  }

  return {
    wss,
    pairing: pairedRuntimeConnectionFromOffer(pairing),
    requests,
    auths,
    connectionCount: () => connectionCount
  }
}

function sendEncrypted(ws: WebSocket, sharedKey: Uint8Array, message: unknown): void {
  ws.send(encrypt(JSON.stringify(message), sharedKey))
}
