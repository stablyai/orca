import type { ChildProcess } from 'node:child_process'
import { runProcessSync, spawnProcess } from '@orca/process-host'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import { request as httpRequest } from 'node:http'
import { createConnection, createServer as createTcpServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

async function port(): Promise<number> {
  const server = createTcpServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No port')
  }
  const result = address.port
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  return result
}

async function proxy(key: Buffer, cert: Buffer, target: number) {
  const observations = { liveControls: 0 }
  const server = createHttpsServer({ key, cert }, (req, res) => {
    const upstream = httpRequest(
      {
        hostname: '127.0.0.1',
        port: target,
        path: req.url,
        method: req.method,
        headers: req.headers
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      }
    )
    upstream.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502)
      }
      res.end()
    })
    req.pipe(upstream)
  })
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/v1/host/control') {
      observations.liveControls++
      socket.once('close', () => observations.liveControls--)
    }
    const upstream = createConnection(target, '127.0.0.1', () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${req.rawHeaders.reduce((s, v, i) => s + v + (i % 2 ? '\r\n' : ': '), '')}\r\n`
      )
      if (head.length) {
        upstream.write(head)
      }
      socket.pipe(upstream).pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('No proxy port')
  }
  return { server, observations, url: `https://127.0.0.1:${address.port}` }
}

export async function startCustomRelayStack() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-relay-e2e-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  const certificate = runProcessSync({
    program: 'openssl',
    args: [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-addext',
      'basicConstraints=critical,CA:TRUE'
    ]
  })
  if (certificate.code !== 0) {
    throw new Error(`Certificate generation failed: ${certificate.stderr}`)
  }
  const key = readFileSync(keyPath)
  const cert = readFileSync(certPath)
  const authPort = await port()
  const relayPort = await port()
  const authProxy = await proxy(key, cert, authPort)
  const relayProxy = await proxy(key, cert, relayPort)
  const secret = 'e2e-only-secret-0123456789abcdef0123456789'
  const preload = path.join(dir, 'loopback.cjs')
  writeFileSync(
    preload,
    `const net = require('node:net'); const listen = net.Server.prototype.listen; net.Server.prototype.listen = function (...args) { if (typeof args[0] === 'number' && (typeof args[1] === 'function' || args[1] === undefined)) args.splice(1, 0, '127.0.0.1'); return listen.apply(this, args) }`
  )
  const cloud = path.join(process.cwd(), 'cloud')
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: certPath, ORCA_BACKGROUND_LAUNCH: '1' }
  const children: ChildProcess[] = []
  const start = (app: string, variables: Record<string, string>) => {
    const child = spawnProcess({
      program: process.execPath,
      args: [
        '--require',
        preload,
        '--import',
        'tsx',
        '--conditions=orca-source',
        `apps/${app}/src/index.ts`
      ],
      cwd: cloud,
      env: { ...env, ...variables },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout?.on('data', (data: Buffer) => process.stdout.write(`[${app}] ${data.toString()}`))
    child.stderr?.on('data', (data: Buffer) => process.stderr.write(`[${app}] ${data.toString()}`))
    children.push(child)
    return child
  }
  start('relay-auth', {
    PORT: String(authPort),
    ORCA_AUTH_ISSUER: authProxy.url,
    ORCA_AUTH_ADMIN_SECRET: secret,
    ORCA_AUTH_EMAIL: 'e2e@example.test',
    ORCA_AUTH_DATA_DIR: path.join(dir, 'auth')
  })
  const relayEnv = {
    PORT: String(relayPort),
    ORCA_RELAY_ROLE: 'combined',
    ORCA_RELAY_PUBLIC_URL: relayProxy.url,
    ORCA_RELAY_CELL_URL: relayProxy.url,
    ORCA_RELAY_AUTH_ISSUER: authProxy.url,
    ORCA_RELAY_JWKS_URL: `${authProxy.url}/.well-known/jwks.json`,
    ORCA_RELAY_ASSIGNMENT_SIGNING_KEY: 'e2e-assignment-key-0123456789abcdef',
    ORCA_RELAY_DATA_DIR: path.join(dir, 'relay'),
    ORCA_RELAY_ADMIN_AUDIENCE: `${relayProxy.url}/admin`,
    ORCA_RELAY_DEPLOY_SERVICE_ACCOUNT: 'e2e@example.test',
    ORCA_RELAY_PUBLIC_ASSIGNMENTS_ENABLED: 'true'
  }
  let relay = start('relay', relayEnv)
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return
    }
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    try {
      await exited
    } finally {
      clearTimeout(timer)
    }
  }
  return {
    authUrl: authProxy.url,
    relayUrl: relayProxy.url,
    certPath,
    cert,
    secret,
    relayObservations: relayProxy.observations,
    stopRelay: () => stop(relay),
    startRelay: () => {
      relay = start('relay', relayEnv)
    },
    close: async () => {
      await Promise.all(children.map(stop))
      await Promise.all(
        [authProxy.server, relayProxy.server].map(
          (server) => new Promise<void>((resolve) => server.close(() => resolve()))
        )
      )
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
