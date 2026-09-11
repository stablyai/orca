import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import WebSocket from 'ws'
import { openInMemoryRelayDatabase } from '../../cloud/apps/relay/src/database'
import { createRelayServer } from '../../cloud/apps/relay/src/relay-server'
import type { RelayConfig } from '../../cloud/apps/relay/src/config'
import type { RelayControlOrigin } from '../../src/main/runtime/relay/relay-control-origin'
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
  const heartbeat = async () => {
    for (const [index, cell] of cells.entries()) {
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
        regionalRehomeProtocol: 2,
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
  const move = async (expectTarget = true) => {
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
    const attempt = await source.assignments.claimRegionalRehome()
    expect(attempt?.retention).toBeDefined()
    const outcome = await source.sessions.drainHost({
      ...identity,
      attemptId: attempt!.attemptId,
      sourceAssignmentEpoch: assignment.assignmentEpoch,
      sourceCellIncarnation: incarnations[0],
      graceMs: 0,
      retention: attempt!.retention
    })
    await source.assignments.recordRegionalRehomeDrainReceipt(attempt!.attemptId, outcome)
    if (expectTarget) {
      await expect.poll(() => pool.activeAssignment?.cellUrl).toBe(cells[1]!.url)
    }
    return attempt!
  }
  const tick = async (sourceOnly = false) => {
    const desktop = pool as unknown as {
      activeOrigin: RelayControlOrigin
      rotation: { rebind(origin: RelayControlOrigin): Promise<void> }
    }
    if (!sourceOnly && desktop.activeOrigin.controlLeaseExpiresAt - clock < 60_000) {
      // Advance the production rotation callback alongside the synthetic cell clock.
      await desktop.rotation.rebind(desktop.activeOrigin)
    }
    clock += 30_000
    for (const relay of sourceOnly ? [source] : servers) {
      const session = relay.sessions.get(identity)
      if (!session) {
        continue
      }
      session.lastPongAt = clock
      const authority = session.authorityRevision
      ;(relay.sessions as unknown as { heartbeat(value: typeof session): void }).heartbeat(session)
      const attempt = session.activityRenewalAttempt
      await expect
        .poll(
          () =>
            session.activityRenewalCompletedAttempt >= attempt ||
            session.authorityRevision > authority,
          { interval: 1 }
        )
        .toBe(true)
      expect(session.state).not.toBe('closed')
      expect(session.leaseExpiresAt).toBeGreaterThan(clock)
    }
    await heartbeat()
    if (!sourceOnly) {
      await source.assignments.refreshRegionalRehomeLeases()
    }
  }
  return {
    source,
    target,
    pool,
    identity,
    database,
    cells,
    attachPhone,
    move,
    tick,
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

describe('region correction across real relay and desktop WebSockets', () => {
  it('keeps quiet and active old connections while new connections use target, without replaying a mutation', async () => {
    const context = await topology()
    const first = await context.attachPhone(0, 'phone-one')
    const quiet = await context.attachPhone(0, 'phone-two')
    const sourceSession = context.source.sessions.get(context.identity)!
    const originalSocket = sourceSession.socket
    const generation = sourceSession.generation
    await echo(first, 'before-move')
    first.send('mutation-1')
    await expect.poll(context.mutations).toBe(1)
    await context.move()
    expect(context.source.sessions.get(context.identity)).toBe(sourceSession)
    expect(sourceSession.socket).toBe(originalSocket)
    expect(sourceSession.generation).toBe(generation)
    expect(sourceSession.activeSplices.size).toBe(2)
    const initialLeaseExpiry = sourceSession.leaseExpiresAt
    for (let index = 0; index < 782; index++) {
      await context.tick()
    }
    expect(context.now()).toBeGreaterThan(initialLeaseExpiry)
    expect(context.source.sessions.get(context.identity)).toBe(sourceSession)
    expect(sourceSession.socket).toBe(originalSocket)
    expect(sourceSession.generation).toBe(generation)
    expect(sourceSession.leaseExpiresAt).toBeGreaterThan(context.now())
    const third = await context.attachPhone(1, 'phone-three')
    await echo(third, 'target-new-connection')
    await echo(first, 'source-after-move')
    const acknowledged = once(first, 'message')
    context.reply()
    expect((await acknowledged)[0].toString()).toBe('mutation-1-ack')
    expect(await context.mutations()).toBe(1)
    await echo(quiet, 'quiet-source-still-live')
    first.close()
    quiet.close()
    await expect
      .poll(() => context.source.sessions.get(context.identity)?.activeSplices.size ?? 0)
      .toBe(0)
    await expect
      .poll(
        async () => {
          const rows = await context.database.query(
            'SELECT COUNT(*) AS count FROM relay_assignment_activity_leases WHERE cell_id = ? AND activity_kind = ?',
            [context.cells[0]!.id, 'control']
          )
          return Number(rows[0]!.count)
        },
        { timeout: 35_000 }
      )
      .toBe(0)
    expect(await context.source.assignments.completeReadyRegionalRehomes()).toBe(1)
    await echo(third, 'target-after-source-retired')
    expect(context.executionErrors).toEqual([])
    expect(context.execution.sequence()).toBe(6)
  }, 90_000)
  it('restores the retained source after target failure despite the first failed director corroboration', async () => {
    const context = await topology()
    const phone = await context.attachPhone(0, 'rollback-phone')
    const sourceSession = context.source.sessions.get(context.identity)!
    const socket = sourceSession.socket
    const generation = sourceSession.generation
    phone.send('mutation-1')
    await expect.poll(context.mutations).toBe(1)
    await context.move()
    const initialLeaseExpiry = sourceSession.leaseExpiresAt
    for (let index = 0; index < 782; index++) {
      await context.tick()
    }
    expect(context.now()).toBeGreaterThan(initialLeaseExpiry)
    context.failTarget()
    await expect
      .poll(() => context.target.sessions.get(context.identity), { timeout: 35_000 })
      .toBeNull()
    for (let index = 0; index < 32; index++) {
      await context.tick(true)
    }
    await context.source.assignments.refreshRegionalRehomeLeases()
    expect(await context.source.assignments.abortExpiredEvacuations()).toBe(1)
    expect(sourceSession.socket).toBe(socket)
    context.failNextCorroboration()
    context.pauseCorroboration(true)
    await context.tick(true)
    expect(sourceSession.regionalRestoration).not.toBeNull()
    expect(sourceSession.assignmentEpoch).toBeGreaterThan(2)
    await expect.poll(context.corroborationFailures, { timeout: 10_000 }).toBeGreaterThan(0)
    const firstRestoredGrant = sourceSession.leaseExpiresAt
    for (let index = 0; index < 5; index++) {
      const failures = context.corroborationFailures()
      await context.tick(true)
      await expect
        .poll(context.corroborationFailures, { timeout: 15_000 })
        .toBeGreaterThan(failures)
    }
    expect(context.now()).toBeGreaterThan(firstRestoredGrant)
    expect(sourceSession.regionalRestoration).not.toBeNull()
    expect(sourceSession.socket).toBe(socket)
    await echo(phone, 'source-awaiting-director-corroboration')
    context.pauseCorroboration(false)
    await context.tick(true)
    await expect
      .poll(() => context.pool.activeAssignment?.cellUrl, { timeout: 35_000 })
      .toBe(context.cells[0]!.url)
    expect(context.source.sessions.get(context.identity)).toBe(sourceSession)
    // Restoration schedules ordinary renewal, which replaces only the control socket.
    await expect.poll(() => sourceSession.regionalRestoration, { timeout: 15_000 }).toBeNull()
    expect(sourceSession.socket).not.toBe(socket)
    expect(sourceSession.generation).toBe(generation)
    expect(sourceSession.activeSplices.size).toBe(1)
    for (let index = 0; index < 5; index++) {
      await context.tick(true)
    }
    await echo(phone, 'source-after-rollback-and-old-short-grant')
    const acknowledged = once(phone, 'message')
    context.reply()
    expect((await acknowledged)[0].toString()).toBe('mutation-1-ack')
    expect(await context.mutations()).toBe(1)
    const newPhone = await context.attachPhone(0, 'rollback-new-phone')
    await echo(newPhone, 'new-source-admission-restored')
    expect(context.executionErrors).toEqual([])
    expect(context.execution.sequence()).toBe(4)
  }, 120_000)
})
