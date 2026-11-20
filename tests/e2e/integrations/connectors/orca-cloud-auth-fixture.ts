// A stand-in Orca Cloud auth service over HTTPS: it approves a server sign-in at once, exchanges its
// code for a session, and mints connector tokens until that session signs out.
import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createServer } from 'node:https'

export const AUTH_USER = { userId: 'user-e2e', email: 'ada@example.test' }

export type OrcaCloudAuth = {
  origin: string
  /** Connector token mints, and the machine id each named. */
  mints: { machineId: unknown }[]
  logouts: () => number
  /** Off, a server sign-in waits for approval for as long as it asks. */
  approveSignIns: (on: boolean) => void
  /** Paths the service had no answer for; a new call the host makes shows up here. */
  unknownPaths: string[]
  close: () => Promise<void>
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(typeof parsed === 'object' && parsed !== null ? { ...parsed } : {})
      } catch {
        resolve({})
      }
    })
  })
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, body === undefined ? {} : { 'content-type': 'application/json' })
  response.end(body === undefined ? undefined : JSON.stringify(body))
}

export async function startOrcaCloudAuth(tls: {
  key: string
  cert: string
}): Promise<OrcaCloudAuth> {
  const mints: { machineId: unknown }[] = []
  const unknownPaths: string[] = []
  const liveTokens = new Set<string>()
  let logouts = 0
  let approve = true
  let origin = ''
  const session = () => {
    const accessToken = `access-${randomUUID()}`
    liveTokens.add(accessToken)
    return {
      accessToken,
      refreshToken: `refresh-${randomUUID()}`,
      expiresAt: Date.now() + 3_600_000,
      cloud: { cloudProfileId: 'cloud-profile-e2e', ...AUTH_USER },
      organizations: [],
      capabilities: { flags: {} }
    }
  }
  const server = createServer(tls, (request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'https://fixture').pathname
      const body = await readJson(request)
      const bearer = request.headers.authorization?.replace(/^Bearer /, '') ?? ''
      switch (path) {
        case '/v1/desktop/auth/clients/orca-server':
          return send(response, 200, { clientId: 'orca-server' })
        case '/v1/server-sign-in/requests':
          return send(response, 201, {
            requestId: 'request-e2e',
            claimToken: 'claim-e2e',
            userCode: 'E2E0-0001',
            verificationUrl: `${origin}/approve`,
            intervalSeconds: 1,
            expiresInSeconds: 300
          })
        // The person approved in their browser before the first poll.
        case '/v1/server-sign-in/requests/poll':
          if (!approve) {
            return send(response, 200, { status: 'pending' })
          }
          return send(response, 200, {
            status: 'approved',
            code: 'code-e2e',
            redirectUri: `${origin}/v1/desktop/auth/server-sign-in/code`
          })
        case '/v1/desktop/auth/session':
          return body.code === 'code-e2e'
            ? send(response, 200, session())
            : send(response, 400, { error: 'invalid_grant' })
        case '/v1/desktop/auth/refresh':
          return send(response, 200, session())
        case '/v1/desktop/auth/capabilities':
          return send(response, 200, { capabilities: { flags: {} } })
        case '/v1/desktop/auth/logout':
          logouts += 1
          liveTokens.clear()
          return send(response, 204)
        case '/v1/desktop/auth/connector-token':
          if (!liveTokens.has(bearer)) {
            return send(response, 401, { error: 'SIGNED_OUT' })
          }
          mints.push({ machineId: body.machineId })
          return send(response, 200, {
            connectorToken: `connector-${randomUUID()}`,
            expiresAt: Math.floor(Date.now() / 1000) + 3_600
          })
        default:
          unknownPaths.push(path)
          return send(response, 404, { error: 'not_found' })
      }
    })().catch(() => send(response, 500, { error: 'fixture_failed' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Orca Cloud auth fixture has no TCP address')
  }
  origin = `https://127.0.0.1:${address.port}`
  return {
    origin,
    mints,
    logouts: () => logouts,
    approveSignIns: (on) => {
      approve = on
    },
    unknownPaths,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
  }
}
