import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Client } from 'ssh2'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { TestInfo } from '@stablyai/playwright-test'
import type { SshConnection } from '../../src/main/ssh/ssh-connection'
import type { SshProviderEpoch } from '../../src/shared/ssh-types'
import { ensureDockerSshRelayImage } from './helpers/docker-ssh-relay-image'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { resolveSshBrowserNetworkExecutionRoute } from '../../src/main/browser/ssh-browser-network-execution-route'

const runDocker = process.env.ORCA_RUN_DOCKER_SSH_BROWSER_E2E === '1'
const executionHost = {
  kind: 'ssh' as const,
  targetId: 'target-a',
  providerEpoch: 'provider-epoch-a',
  connectionGeneration: 2
}

describe.runIf(runDocker)('SSH browser network execution route Docker journey', () => {
  let target: DockerSshRelayTarget | null = null
  let client: Client | null = null

  beforeAll(async () => {
    ensureDockerSshRelayImage(process.cwd())
    target = startDockerSshRelayTarget({ workerIndex: 0 } as TestInfo)
    execDockerSshRelayTargetCommand(
      target,
      "grep -q 'remote-only.internal' /etc/hosts || printf '127.0.0.1 remote-only.internal\\n' >> /etc/hosts"
    )
    const server = [
      "const http=require('http')",
      "http.createServer((_request,response)=>response.end('sta-4150-remote-only')).listen(18080,'127.0.0.1')"
    ].join(';')
    execDockerSshRelayTargetCommand(
      target,
      `nohup node -e ${shellQuote(server)} >/tmp/sta-4150-http.log 2>&1 </dev/null &`
    )
    const waitForServer = [
      "const net=require('net')",
      'const deadline=Date.now()+5000',
      "const probe=()=>{const socket=net.connect(18080,'127.0.0.1')",
      "socket.once('connect',()=>{socket.destroy();process.exit(0)})",
      "socket.once('error',()=>{socket.destroy();if(Date.now()>=deadline)process.exit(1);setTimeout(probe,25)})}",
      'probe()'
    ].join(';')
    execDockerSshRelayTargetCommand(target, `node -e ${shellQuote(waitForServer)}`)
    client = new Client()
    await new Promise<void>((resolve, reject) => {
      client!.once('ready', resolve)
      client!.once('error', reject)
      client!.connect({
        host: target!.host,
        port: target!.port,
        username: 'root',
        privateKey: readFileSync(target!.identityFile),
        hostVerifier: () => true
      })
    })
  }, 120_000)

  afterAll(() => {
    if (client) {
      client.end()
    }
    cleanupDockerSshRelayTarget(target)
  })

  it('resolves and connects the exact remote-only domain on the SSH host', async () => {
    const connection = {
      getState: () => ({
        targetId: 'target-a',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      }),
      getClient: () => client,
      usesSystemSshTransport: () => false
    } as unknown as SshConnection
    const authorityAbort = new AbortController()
    const forwardOut = vi.spyOn(client!, 'forwardOut')
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: (authority) =>
          authority.providerEpoch === ('provider-epoch-a' as SshProviderEpoch) &&
          authority.connectionGeneration === 2,
        registerAuthorityAbort: (_authority, controller) => {
          authorityAbort.signal.addEventListener('abort', () => controller.abort(), { once: true })
          return () => {}
        }
      }
    )
    const socket = route.connect({ host: 'remote-only.internal', port: 18080 })
    socket.on('error', () => {})
    await once(socket as never, 'connect')
    const response = readHttpResponse(socket)
    socket.resume()
    socket.write(
      new TextEncoder().encode(
        'GET / HTTP/1.1\r\nHost: remote-only.internal\r\nConnection: close\r\n\r\n'
      )
    )

    await expect(response).resolves.toContain('sta-4150-remote-only')
    expect(forwardOut).toHaveBeenCalledWith(
      '127.0.0.1',
      0,
      'remote-only.internal',
      18080,
      expect.any(Function)
    )
    authorityAbort.abort()
    await route.whenInvalidated
    expect(route.isValid()).toBe(false)
    await route.close()
  })

  it('runs the same remote-only journey through one system-SSH dynamic forward', async () => {
    const configFile = path.join(target!.tempDir, 'browser-tunnel-ssh-config')
    writeFileSync(
      configFile,
      [
        'Host sta-4150-docker',
        `  HostName ${target!.host}`,
        `  Port ${target!.port}`,
        '  User root',
        `  IdentityFile ${target!.identityFile}`,
        '  IdentitiesOnly yes',
        '  StrictHostKeyChecking no',
        '  UserKnownHostsFile /dev/null'
      ].join('\n')
    )
    const connection = {
      getState: () => ({
        targetId: 'target-a',
        status: 'connected',
        error: null,
        reconnectAttempt: 0
      }),
      getClient: () => null,
      usesSystemSshTransport: () => true,
      getTarget: () => ({
        id: 'target-a',
        label: 'Docker system SSH',
        configHost: 'sta-4150-docker',
        host: target!.host,
        port: target!.port,
        username: 'root',
        source: 'ssh-config' as const
      }),
      getSystemSshBuildArgsOptions: () => ({ configFile })
    } as unknown as SshConnection
    const route = await resolveSshBrowserNetworkExecutionRoute(
      { executionHost, runtimeId: 'runtime-a', runtimeRevision: 1 },
      {
        connectionManager: { getConnection: () => connection },
        isCurrentAuthority: () => true,
        registerAuthorityAbort: () => () => {}
      }
    )
    const socket = route.connect({ host: 'remote-only.internal', port: 18080 })
    socket.on('error', () => {})
    await once(socket as never, 'connect')
    const response = readHttpResponse(socket)
    socket.resume()
    socket.write(
      new TextEncoder().encode(
        'GET / HTTP/1.1\r\nHost: remote-only.internal\r\nConnection: close\r\n\r\n'
      )
    )

    await expect(response).resolves.toContain('sta-4150-remote-only')
    await route.close()
  })
})

function readHttpResponse(socket: {
  on(event: 'data', listener: (bytes: Uint8Array<ArrayBufferLike>) => void): unknown
  on(event: 'end', listener: () => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array<ArrayBufferLike>[] = []
    socket.on('data', (bytes) => chunks.push(bytes.slice()))
    socket.on('error', reject)
    socket.on('end', () => {
      const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
      const response = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        response.set(chunk, offset)
        offset += chunk.byteLength
      }
      resolve(new TextDecoder().decode(response))
    })
  })
}
