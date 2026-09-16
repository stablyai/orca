import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import type { IdleRegionalRehomeRequest } from '../../cloud/packages/relay-contract/src/idle-regional-rehome'
import {
  openInMemoryRelayDatabase,
  readRelayDatabasePoolPressure
} from '../../cloud/apps/relay/src/database'
import { createRelayServer } from '../../cloud/apps/relay/src/relay-server'
import type { RelayConfig } from '../../cloud/apps/relay/src/config'
import type * as AdminTokenVerifier from '../../cloud/apps/relay/src/admin-token-verifier'
import { RelayOriginPool } from '../../src/main/runtime/relay/relay-origin-pool'
import { RELAY_HOST_CAPABILITY_HEADERS } from '../../src/main/runtime/relay/relay-control-protocol'
import type { MobileSocketTransport } from '../../src/main/runtime/rpc/mobile-socket-wiring'
import { createRelayExecutionProcess } from './helpers/relay-execution-process'

vi.mock('../../cloud/apps/relay/src/relay-token-verifier', () => ({
  createRelayTokenVerifier: () => async (hostId: string) => ({
    sub: 'transport-test-user',
    prof: 'profile-1',
    org: 'org-1',
    relayHostId: hostId,
    purpose: 'host-control',
    exp: 4_102_444_800
  }),
  readBearer: (value: string | undefined) => value?.replace(/^Bearer /, '') ?? null
}))

vi.mock('../../cloud/apps/relay/src/admin-token-verifier', async (importOriginal) => ({
  ...(await importOriginal<typeof AdminTokenVerifier>()),
  createRegionalRehomeTokenVerifier: () => async (token: string) => token === 'test-director-token'
}))

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  const failures: unknown[] = []
  for (const cleanup of cleanups.splice(0).toReversed()) {
    try {
      await cleanup()
    } catch (error) {
      failures.push(error)
    }
  }
  vi.restoreAllMocks()
  if (failures.length > 0) {
    throw new AggregateError(failures, 'relay topology cleanup failed')
  }
})

async function topology() {
  const execution = await createRelayExecutionProcess()
  cleanups.push(() => execution.close())
  let clock = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
  const database = await openInMemoryRelayDatabase()
  cleanups.push(() => database.close())
  const keypair = nacl.box.keyPair()
  const hostId = createHash('sha256').update(keypair.publicKey).digest('base64url').slice(0, 16)
  const identity = { userId: 'transport-test-user', relayHostId: hostId }
  const cells = [
    {
      id: 'transport-us',
      url: 'https://transport-us.example.test',
      region: 'us-central1' as const,
      capacityRequests: 100
    },
    {
      id: 'transport-asia',
      url: 'https://transport-asia.example.test',
      region: 'asia-east2' as const,
      capacityRequests: 100
    }
  ]
  const incarnations = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222'
  ]
  const endpoints = new Map<string, string>()
  const sockets = new Set<WebSocket>()
  const servers = cells.map((cell, index) =>
    createRelayServer(
      {
        port: 0,
        publicUrl: cell.url,
        cellUrl: cell.url,
        role: 'cell',
        cellId: cell.id,
        region: cell.region,
        cells,
        dataDir: '',
        authIssuer: 'https://auth.example.test',
        authAudience: 'orca-relay',
        adminJwksUrl: 'https://auth.example.test/jwks',
        jwksUrl: 'https://auth.example.test/jwks',
        assignmentSigningKey: new Uint8Array(32),
        adminAudience: 'https://director.example.test/v1/admin/drain',
        deployServiceAccount: 'deploy@example.test',
        rehomeAudience: 'https://director.example.test/v1/admin/host-drain',
        rehomeDirectorServiceAccount: 'director@example.test',
        databasePoolMax: 1,
        publicAssignmentsEnabled: true,
        publicAssignmentConcurrency: 2,
        publicAssignmentQueueMax: 128,
        publicAssignmentWaitMs: 4_000,
        publicResolveConcurrency: 1,
        publicResolveWaitMs: 5_000,
        publicAssignmentRetryAfterSeconds: 5,
        regionCorrectionCohortPercent: 100
      } as RelayConfig,
      database,
      { now: () => clock, random: () => 0.5, cellIncarnation: incarnations[index] }
    )
  )
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.terminate()
    }
    for (const relay of servers) {
      relay.sessions.drain(0)
      await new Promise<void>((resolve) => relay.server.close(() => resolve()))
    }
  })
  const source = servers[0]!
  const target = servers[1]!
  await source.assignments.inspectRegionalRehomeControl()
  clock += 86_400_000
  await source.assignments.applyRegionalRehomeControl({
    expectedGeneration: 0,
    enabled: true,
    notBefore: clock,
    ratePerMinute: 10,
    preferenceMaxAgeMs: 86_400_000,
    hostCooldownMs: 604_800_000,
    drainGraceMs: 60_000
  })
  await source.assignments.reconcileCells(cells)
  const startedAt = clock - 1_000
  const safety = () => ({
    observedAt: clock,
    sqlFailures: 0,
    reconnects: 0,
    controlActivityRecoveryFailures: 0,
    databasePoolWaiting: 0,
    databasePoolWaitersMax: 0,
    databasePoolWaitMsMax: 0
  })
  const heartbeat = async () => {
    for (const [index, cell] of cells.entries()) {
      const relay = servers[index]!
      relay.observability.flush({
        ...relay.runtimeCounts(),
        ...readRelayDatabasePoolPressure(database)
      })
      await source.assignments.recordCellHeartbeat({
        cellId: cell.id,
        cellUrl: cell.url,
        region: cell.region,
        cellIncarnation: incarnations[index]!,
        startedAt,
        ready: true,
        observedRequests: 0
      })
      await source.assignments.recordCellRegionalRehomeStatus({
        cellId: cell.id,
        cellIncarnation: incarnations[index]!,
        regionalRehomeProtocol: 3,
        safety: {
          observedAt: clock,
          sqlFailures: 0,
          reconnects: 0,
          controlActivityRecoveryFailures: 0,
          databasePoolWaiting: 0,
          databasePoolWaitersMax: 0,
          databasePoolWaitMsMax: 0
        }
      })
    }
  }
  await heartbeat()
  for (const [index, relay] of servers.entries()) {
    relay.server.listen(0, '127.0.0.1')
    await once(relay.server, 'listening')
    const address = relay.server.address()
    if (!address || typeof address === 'string') {
      throw new Error('missing local address')
    }
    endpoints.set(new URL(cells[index]!.url).host, `ws://127.0.0.1:${address.port}`)
  }
  const connect = (url: string, headers?: Record<string, string>) => {
    const parsed = new URL(url)
    const socket = new WebSocket(`${endpoints.get(parsed.host)}${parsed.pathname}`, { headers })
    sockets.add(socket)
    return socket
  }
  let failCorroboration = 0
  let pauseCorroboration = false
  let corroborationFailures = 0
  let rejectTargetControls = false
  let targetControlFailures = 0
  const executionErrors: unknown[] = []
  let delayedReply: (() => void) | null = null
  const received: string[] = []
  const pool = new RelayOriginPool({
    directorUrl: 'https://director.example.test',
    relayHostId: hostId,
    identity: { userId: identity.userId, profileId: 'profile-1', organizationId: 'org-1' },
    keypair: { ...keypair, publicKeyB64: Buffer.from(keypair.publicKey).toString('base64') },
    appVersion: 'transport-test',
    isCurrent: () => true,
    onStatus: () => {},
    now: () => clock,
    mobileSocketWiring: {
      attachTransport: (transport: MobileSocketTransport) => {
        transport.onMessage((raw, reply) => {
          const value = raw.toString()
          received.push(value)
          void execution
            .execute(value)
            .then((output) => {
              if (output === 'mutation-1') {
                delayedReply = () => reply('mutation-1-ack')
              } else {
                reply(`host:${output}`)
              }
            })
            .catch((error) => executionErrors.push(error))
        })
        return () => {}
      }
    } as never,
    createControlSocket: (url, token) => {
      if (rejectTargetControls && new URL(url).host === new URL(cells[1]!.url).host) {
        targetControlFailures++
        throw new Error('simulated_target_unavailable')
      }
      const socket = connect(url, {
        authorization: `Bearer ${token}`,
        ...RELAY_HOST_CAPABILITY_HEADERS
      })
      if (process.env.ORCA_RELAY_TRANSPORT_DIAGNOSTICS === '1') {
        const cell = new URL(url).host
        console.info('transport-control-created', {
          cell,
          stack: new Error('transport control created').stack
        })
        socket.on('message', (raw) => {
          const message = JSON.parse(raw.toString())
          if (['region-restored', 'host-hello-ack', 'drain'].includes(message.type)) {
            console.info('transport-control-message', {
              cell,
              type: message.type,
              assignmentEpoch: message.assignmentEpoch,
              generation: message.generation
            })
          }
        })
        socket.on('close', (code) => console.info('transport-control-close', { cell, code }))
      }
      return socket
    },
    createDataSocket: (url) => connect(url),
    fetch: (async () => {
      if (failCorroboration > 0 || pauseCorroboration) {
        failCorroboration = Math.max(0, failCorroboration - 1)
        corroborationFailures++
        return Response.json({ error: 'temporary_director_failure' }, { status: 503 })
      }
      const assignment = await source.assignments.resolve(identity)
      if (!assignment) {
        return Response.json({ error: 'assignment_not_found' }, { status: 409 })
      }
      return Response.json({
        v: 1,
        cellUrl: assignment.cellUrl,
        assignmentEpoch: assignment.assignmentEpoch,
        lease: 'synthetic-assignment-lease'
      })
    }) as typeof fetch
  })
  cleanups.push(async () => {
    pool.closeNow()
  })
  const assignment = await source.assignments.assign(identity, 'us-central1')
  await pool.openInitial(
    {
      v: 1,
      cellUrl: assignment.cellUrl,
      assignmentEpoch: assignment.assignmentEpoch,
      lease: 'synthetic-assignment-lease'
    },
    hostId
  )
  const attachPhone = async (cellIndex: number, device: string) => {
    const invite = await source.store.createInvite(identity, device)
    const socket = connect(`${cells[cellIndex]!.url}/v1/connect/${hostId}`)
    await once(socket, 'open')
    const hello = once(socket, 'message')
    socket.send(
      JSON.stringify({ type: 'relay-auth', v: 1, mode: 'connect', credential: invite.inviteToken })
    )
    const [raw] = await hello
    expect(JSON.parse(raw.toString())).toMatchObject({ type: 'relay-hello', ok: true })
    return socket
  }
  let candidate: (IdleRegionalRehomeRequest & { sourceCellUrl: string }) | undefined
  const prepareMove = async () => {
    const issued = await source.assignments.exchangeRegionCorrection(
      identity,
      { v: 1, action: 'issue-window' },
      assignment.assignmentEpoch
    )
    await source.assignments.exchangeRegionCorrection(
      identity,
      {
        v: 1,
        action: 'report',
        generation: issued.window!.generation,
        assignmentEpoch: assignment.assignmentEpoch,
        policyVersion: 1,
        outcome: 'conclusive',
        measurements: { 'us-central1': 180, 'asia-east2': 40 }
      },
      assignment.assignmentEpoch
    )
    candidate = (await source.assignments.selectIdleRegionalRehomeCandidates(safety()))[0]
    expect(candidate).toBeDefined()
    return candidate!
  }
  const move = async () => {
    if (!candidate) {
      await prepareMove()
    }
    const { sourceCellUrl, ...request } = candidate!
    const address = endpoints.get(new URL(sourceCellUrl).host)!.replace('ws:', 'http:')
    const response = await fetch(`${address}/v1/admin/host-idle-rehome`, {
      method: 'POST',
      headers: { authorization: 'Bearer test-director-token', 'content-type': 'application/json' },
      body: JSON.stringify({ ...request, cohortPercent: 100, directorSafety: safety() })
    })
    const body = (await response.json()) as { v: number; outcome: string }
    expect(response.status, JSON.stringify(body)).toBe(200)
    return { outcome: body.outcome }
  }
  return {
    source,
    target,
    pool,
    identity,
    database,
    cells,
    attachPhone,
    connectDevice: () => connect(`${cells[0]!.url}/v1/connect/${hostId}`),
    move,
    prepareMove,
    heartbeat,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms
    },
    received,
    failNextCorroboration: () => {
      failCorroboration = 1
    },
    pauseCorroboration: (paused: boolean) => {
      pauseCorroboration = paused
    },
    corroborationFailures: () => corroborationFailures,
    targetControlFailures: () => targetControlFailures,
    failTarget: () => {
      rejectTargetControls = true
      const session = target.sessions.get(identity)
      if (session?.socket) {
        session.socket.terminate()
      }
    },
    execution,
    executionErrors,
    mutations: () => execution.mutations(),
    reply: () => {
      if (!delayedReply) {
        throw new Error('no delayed mutation')
      }
      delayedReply()
    }
  }
}

async function echo(socket: WebSocket, value: string) {
  const marker = `${value}:${randomUUID()}`
  const response = once(socket, 'message')
  socket.send(marker)
  const [raw] = await response
  expect(raw.toString()).toBe(`host:${marker}`)
}

describe('idle region correction across real relay and desktop WebSockets', () => {
  it('releases the empty source and recovers normally when the target never registers', async () => {
    const context = await topology()
    await context.prepareMove()
    context.failTarget()
    expect(await context.move()).toEqual({ outcome: 'committed' })
    await expect.poll(() => context.source.sessions.get(context.identity)).toBeNull()
    await expect
      .poll(async () =>
        context.database.query(
          `SELECT activity_id FROM relay_assignment_activity_leases
       WHERE user_id = ? AND relay_host_id = ? AND cell_id = ?`,
          [context.identity.userId, context.identity.relayHostId, context.cells[0]!.id]
        )
      )
      .toEqual([])
    await expect.poll(context.targetControlFailures).toBeGreaterThan(0)
    context.advance(15 * 60_000 + 1)
    await context.heartbeat()
    expect(await context.source.assignments.abortExpiredEvacuations()).toBe(1)
    expect(await context.source.assignments.resolve(context.identity)).toMatchObject({
      cellId: context.cells[0]!.id,
      assignmentEpoch: 3
    })
    await expect
      .poll(() => context.pool.activeAssignment?.cellUrl, { timeout: 15_000 })
      .toBe(context.cells[0]!.url)
    await expect
      .poll(() => context.source.sessions.get(context.identity)?.state, { timeout: 15_000 })
      .toBe('active')
    const returning = await context.attachPhone(0, 'phone-after-target-failure')
    await echo(returning, 'after-target-failure')
    expect(await context.mutations()).toBe(0)
    expect(context.executionErrors).toEqual([])
  }, 30_000)

  it('rejects an arrival during cutover and restores admissions after a definite failed commit', async () => {
    const context = await topology()
    await context.prepareMove()
    const original = context.source.sessions.get(context.identity)!
    let entered!: () => void
    let release!: () => void
    const committing = new Promise<void>((resolve) => {
      entered = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(context.source.assignments, 'commitIdleRegionalRehome').mockImplementationOnce(
      async () => {
        entered()
        await gate
        throw new Error('simulated_database_unavailable_before_commit')
      }
    )
    const move = context.move()
    await committing
    try {
      const invite = await context.source.store.createInvite(context.identity, 'racing-phone')
      const arriving = context.connectDevice()
      const rejected = once(arriving, 'close')
      await once(arriving, 'open')
      arriving.send(
        JSON.stringify({
          type: 'relay-auth',
          v: 1,
          mode: 'connect',
          credential: invite.inviteToken
        })
      )
      expect((await rejected)[0]).toBe(4409)
      expect(context.source.sessions.get(context.identity)).toBe(original)
    } finally {
      release()
      await move
    }
    expect(await move).toEqual({ outcome: 'deferred' })
    expect(context.source.sessions.get(context.identity)).toBe(original)
    const returning = await context.attachPhone(0, 'retrying-phone')
    await echo(returning, 'after-definite-abort')
    expect(await context.mutations()).toBe(0)
    expect(context.executionErrors).toEqual([])
  }, 30_000)

  it('defers for either connected device, then moves after both disconnect without replaying work', async () => {
    const context = await topology()
    const phone = await context.attachPhone(0, 'phone')
    const tablet = await context.attachPhone(0, 'tablet')
    const sourceSession = context.source.sessions.get(context.identity)!
    await echo(phone, 'before-cutover')
    phone.send('mutation-1')
    await expect.poll(context.mutations).toBe(1)
    expect(await context.move()).toEqual({ outcome: 'busy' })
    expect(context.source.sessions.get(context.identity)).toBe(sourceSession)
    expect((await context.source.assignments.resolve(context.identity))?.cellId).toBe(
      context.cells[0]!.id
    )
    const acknowledged = once(phone, 'message')
    context.reply()
    expect((await acknowledged)[0].toString()).toBe('mutation-1-ack')
    const phoneClosed = once(phone, 'close')
    phone.close()
    await phoneClosed
    await expect.poll(() => sourceSession.activeSplices.size).toBe(1)
    expect(await context.move()).toEqual({ outcome: 'busy' })
    await echo(tablet, 'quiet-tablet-still-connected')
    const tabletClosed = once(tablet, 'close')
    tablet.close()
    await tabletClosed
    await expect.poll(() => sourceSession.activeSplices.size).toBe(0)
    expect(await context.move()).toEqual({ outcome: 'committed' })
    await expect
      .poll(() => context.pool.activeAssignment?.cellUrl, { timeout: 15_000 })
      .toBe(context.cells[1]!.url)
    await expect.poll(() => context.source.sessions.get(context.identity)).toBeNull()
    const returning = await context.attachPhone(1, 'returning-phone')
    await echo(returning, 'after-idle-cutover')
    expect(await context.mutations()).toBe(1)
    expect(context.executionErrors).toEqual([])
    expect(context.execution.sequence()).toBe(4)
  }, 30_000)
})
