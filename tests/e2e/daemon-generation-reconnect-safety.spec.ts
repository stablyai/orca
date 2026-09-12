import { fork, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type TestInfo } from '@playwright/test'
import { DaemonClient } from '../../src/main/daemon/client'
import {
  CLEAN_DISCONNECT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  PTY_STARTUP_INGRESS_PROTOCOL_VERSION
} from '../../src/main/daemon/types'
import {
  cleanupDaemonGenerationFixtures,
  createDaemonGenerationRuntime,
  launchDaemonGeneration,
  spawnGenerationCanary,
  type DaemonGeneration,
  type DaemonGenerationRuntime,
  type GenerationCanary
} from './helpers/daemon-generation-safety-fixtures'
import {
  processIdentityLiveness,
  recordProcessIdentity,
  recordProcessTree,
  terminateRecordedTree,
  waitForCondition,
  type RecordedProcessIdentity
} from './helpers/daemon-generation-processes'

const ALL_GENERATION_PROTOCOLS = [
  ...new Set([
    21,
    22,
    23,
    CLEAN_DISCONNECT_PROTOCOL_VERSION,
    PTY_STARTUP_INGRESS_PROTOCOL_VERSION,
    PROTOCOL_VERSION
  ])
]
const configuredReconnectBursts = Number.parseInt(
  process.env.ORCA_DAEMON_GENERATION_RECONNECT_BURSTS ?? '3',
  10
)
const RECONNECT_BURSTS =
  Number.isInteger(configuredReconnectBursts) && configuredReconnectBursts > 0
    ? configuredReconnectBursts
    : 3

type LivenessReport = {
  daemons: Record<string, boolean>
  roots: Record<string, boolean>
  descendants: Record<string, boolean>
}

type CloseBurstReport = {
  closeAttempts: Record<string, number>
}

function generationLabel(protocolVersion: number): string {
  return `generation-v${protocolVersion}`
}

function canaryLabel(canary: GenerationCanary): string {
  return `${canary.generation.label}-${canary.role}`
}

function killEvents(generation: DaemonGeneration, sessionId: string): Record<string, unknown>[] {
  return generation
    .logEvents()
    .filter((event) => event.event === 'session-killed' && event.sessionId === sessionId)
}

function helloCount(generation: DaemonGeneration): number {
  return generation.logEvents().filter((event) => event.event === 'client-hello-accepted').length
}

async function collectLiveness(
  generations: readonly DaemonGeneration[],
  canaries: readonly GenerationCanary[]
): Promise<LivenessReport> {
  const identities: RecordedProcessIdentity[] = [
    ...generations.map((generation) => generation.identity),
    ...canaries.flatMap((canary) => [canary.rootIdentity, canary.descendantIdentity])
  ]
  const live = await processIdentityLiveness(identities)
  return {
    daemons: Object.fromEntries(
      generations.map((generation) => [
        generation.label,
        live.get(generation.identity.pid) === true
      ])
    ),
    roots: Object.fromEntries(
      canaries.map((canary) => [canaryLabel(canary), live.get(canary.rootIdentity.pid) === true])
    ),
    descendants: Object.fromEntries(
      canaries.map((canary) => [
        canaryLabel(canary),
        live.get(canary.descendantIdentity.pid) === true
      ])
    )
  }
}

function launchReconnectClient(options: {
  runtime: DaemonGenerationRuntime
  generations: readonly DaemonGeneration[]
  canaries: readonly GenerationCanary[]
}): { child: ChildProcess; ready: Promise<CloseBurstReport>; finish(): void; output(): string } {
  const { runtime, generations, canaries } = options
  const configPath = path.join(runtime.rootDir, 'reconnect-client-config.json')
  writeFileSync(
    configPath,
    `${JSON.stringify({
      generations: generations.map((generation) => ({
        protocolVersion: generation.protocolVersion,
        socketPath: generation.socketPath,
        tokenPath: generation.tokenPath
      })),
      currentProtocolVersion: PROTOCOL_VERSION,
      daemonDir: runtime.daemonDir,
      historyDir: path.join(runtime.userDataDir, 'terminal-history'),
      sessions: canaries.map((canary) => ({
        protocolVersion: canary.generation.protocolVersion,
        sessionId: canary.sessionId,
        rootPid: canary.rootIdentity.pid,
        label: canaryLabel(canary),
        role: canary.role
      })),
      reconnectBursts: RECONNECT_BURSTS,
      cwd: runtime.rootDir
    })}\n`
  )
  let output = ''
  const child = fork(runtime.reconnectClientEntryPath, ['--config', configPath], {
    cwd: runtime.userDataDir,
    execPath: runtime.electronPath,
    windowsHide: true,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NODE_PATH: path.join(process.cwd(), 'node_modules'),
      ORCA_USER_DATA_PATH: runtime.userDataDir
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc']
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    output = `${output}${chunk.toString('utf8')}`.slice(-32_768)
  })
  const ready = new Promise<CloseBurstReport>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Reconnect client timed out: ${output}`)),
      60_000
    )
    const settle = (callback: () => void): void => {
      clearTimeout(timer)
      child.off('message', onMessage)
      child.off('exit', onExit)
      callback()
    }
    const onExit = (code: number | null): void =>
      settle(() => reject(new Error(`Reconnect client exited with ${code}: ${output}`)))
    const onMessage = (message: unknown): void => {
      const payload = message as {
        type?: unknown
        message?: unknown
        closeAttempts?: Record<string, number>
      }
      if (payload.type === 'error') {
        settle(() => reject(new Error(String(payload.message))))
      } else if (payload.type === 'close-bursts-complete') {
        settle(() => resolve({ closeAttempts: payload.closeAttempts ?? {} }))
      }
    }
    child.on('message', onMessage)
    child.once('exit', onExit)
  })
  return {
    child,
    ready,
    finish: () => {
      if (!child.connected) {
        return
      }
      try {
        child.send?.({ type: 'finish' }, () => {})
      } catch {
        // The fixture can finish between the connected check and the IPC write.
      }
    },
    output: () => output
  }
}

async function finishReconnectClient(
  client: ReturnType<typeof launchReconnectClient>
): Promise<void> {
  if (!client.child.pid || client.child.exitCode !== null) {
    return
  }
  const identity = await recordProcessIdentity(client.child.pid)
  client.finish()
  try {
    await waitForCondition('reconnect client exit', () => client.child.exitCode !== null, 2_000)
  } catch {
    await terminateRecordedTree(await recordProcessTree(identity))
  }
}

function writeEventReconstruction(options: {
  testInfo: TestInfo
  generations: readonly DaemonGeneration[]
  beforeClose: LivenessReport
  afterClose: LivenessReport
  helloBaselines: ReadonlyMap<number, number>
  targetCanaries: readonly GenerationCanary[]
  closeBurst: CloseBurstReport
  clientPid: number | undefined
}): void {
  const {
    testInfo,
    generations,
    beforeClose,
    afterClose,
    helloBaselines,
    targetCanaries,
    closeBurst,
    clientPid
  } = options
  writeFileSync(
    testInfo.outputPath('daemon-generation-reconnect-events.json'),
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        reconnectClientPid: clientPid,
        beforeClose,
        afterClose,
        closeBurst,
        generations: generations.map((generation) => ({
          label: generation.label,
          protocolVersion: generation.protocolVersion,
          daemonPid: generation.identity.pid,
          daemonStartedAtMs: generation.identity.startedAtMs,
          acceptedHellosDuringReconnect:
            helloCount(generation) - (helloBaselines.get(generation.protocolVersion) ?? 0),
          targetKills: targetCanaries
            .filter((canary) => canary.generation === generation)
            .map((canary) => ({
              sessionId: canary.sessionId,
              events: killEvents(generation, canary.sessionId)
            }))
        }))
      },
      null,
      2
    )}\n`
  )
}

async function cleanupGenerationTestFixtures(options: {
  runtime: DaemonGenerationRuntime
  generations: readonly DaemonGeneration[]
  canaries: readonly GenerationCanary[]
  retainDiagnostics: boolean
}): Promise<void> {
  const { runtime, generations, canaries, retainDiagnostics } = options
  if (retainDiagnostics) {
    runtime.retainDiagnostics(generations)
  }
  try {
    await cleanupDaemonGenerationFixtures({ generations, canaries })
  } catch (error) {
    runtime.retainDiagnostics(generations)
    throw error
  }
  runtime.remove()
}

test.describe.configure({ mode: 'serial' })

test('native Windows reconnect cannot turn stale mirror exits into cross-generation kills', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument before testInfo.
{}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Native Windows named pipes and ConPTY are required')
  test.setTimeout(180_000)
  const fixtureRuntime = await createDaemonGenerationRuntime(testInfo)
  const generations: DaemonGeneration[] = []
  const canaries: GenerationCanary[] = []
  let client: ReturnType<typeof launchReconnectClient> | null = null
  let assertionsComplete = false

  try {
    for (const protocolVersion of ALL_GENERATION_PROTOCOLS) {
      const generation = await launchDaemonGeneration({
        runtime: fixtureRuntime,
        label: generationLabel(protocolVersion),
        protocolVersion
      })
      generations.push(generation)
      for (const role of ['live', 'stale-mirror'] as const) {
        canaries.push(await spawnGenerationCanary({ runtime: fixtureRuntime, generation, role }))
      }
    }
    expect(new Set(generations.map((generation) => generation.socketPath)).size).toBe(
      ALL_GENERATION_PROTOCOLS.length
    )
    expect(
      generations.every(
        (generation) =>
          generation.socketPath.startsWith('\\\\') &&
          generation.socketPath.includes(
            `\\pipe\\orca-terminal-host-v${generation.protocolVersion}-`
          )
      )
    ).toBe(true)

    const helloBaselines = new Map(
      generations.map((generation) => [generation.protocolVersion, helloCount(generation)])
    )
    for (const canary of canaries) {
      await canary.adapter.disconnectOnly()
      canary.adapter.dispose()
    }
    const beforeClose = await collectLiveness(generations, canaries)
    expect(Object.values(beforeClose.daemons).every(Boolean)).toBe(true)
    expect(Object.values(beforeClose.roots).every(Boolean)).toBe(true)
    expect(Object.values(beforeClose.descendants).every(Boolean)).toBe(true)

    client = launchReconnectClient({ runtime: fixtureRuntime, generations, canaries })
    const closeBurst = await client.ready
    expect(client.child.exitCode).toBeNull()
    for (const generation of generations) {
      expect(
        helloCount(generation) - helloBaselines.get(generation.protocolVersion)!
      ).toBeGreaterThanOrEqual(RECONNECT_BURSTS * 2)
    }

    const targetCanaries = canaries.filter((canary) => canary.role === 'stale-mirror')
    expect(Object.values(closeBurst.closeAttempts)).toHaveLength(targetCanaries.length)
    expect(Object.values(closeBurst.closeAttempts).every((attempts) => attempts === 3)).toBe(true)
    const afterFirstClient = await collectLiveness(generations, canaries)
    expect(client.child.exitCode).toBeNull()
    expect(Object.values(afterFirstClient.roots).every(Boolean)).toBe(true)
    expect(Object.values(afterFirstClient.descendants).every(Boolean)).toBe(true)

    const firstClient = client
    await finishReconnectClient(firstClient)
    client = launchReconnectClient({ runtime: fixtureRuntime, generations, canaries })
    const relaunchCloseBurst = await client.ready
    expect(client.child.exitCode).toBeNull()
    const combinedCloseBurst: CloseBurstReport = {
      closeAttempts: Object.fromEntries(
        Object.entries(closeBurst.closeAttempts).map(([tabId, attempts]) => [
          tabId,
          attempts + (relaunchCloseBurst.closeAttempts[tabId] ?? 0)
        ])
      )
    }
    expect(
      Object.values(combinedCloseBurst.closeAttempts).every((attempts) => attempts === 6)
    ).toBe(true)
    const afterClose = await collectLiveness(generations, canaries)
    writeEventReconstruction({
      testInfo,
      generations,
      beforeClose,
      afterClose,
      helloBaselines,
      targetCanaries,
      closeBurst: combinedCloseBurst,
      clientPid: client.child.pid
    })
    expect(client.child.exitCode).toBeNull()
    expect(Object.values(afterClose.daemons).every(Boolean)).toBe(true)
    expect(Object.values(afterClose.roots).every(Boolean)).toBe(true)
    expect(Object.values(afterClose.descendants).every(Boolean)).toBe(true)
    // Why: each stale mirror crossed desktop and two remote-profile close paths
    // before and after an app-process relaunch; process health cannot hide a kill.
    expect(
      targetCanaries.every((canary) => killEvents(canary.generation, canary.sessionId).length === 0)
    ).toBe(true)
    expect(targetCanaries.every((canary) => afterClose.roots[canaryLabel(canary)])).toBe(true)
    assertionsComplete = true
  } finally {
    if (client) {
      await finishReconnectClient(client)
    }
    await cleanupGenerationTestFixtures({
      runtime: fixtureRuntime,
      generations,
      canaries,
      retainDiagnostics: !assertionsComplete
    })
  }
})

test('shutdown disposal failure drops authority within a bounded window', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument before testInfo.
{}, testInfo) => {
  test.skip(process.platform !== 'win32', 'Native Windows named pipes and ConPTY are required')
  test.setTimeout(60_000)
  const fixtureRuntime = await createDaemonGenerationRuntime(testInfo)
  const generations: DaemonGeneration[] = []
  const canaries: GenerationCanary[] = []
  let assertionsComplete = false

  try {
    const generation = await launchDaemonGeneration({
      runtime: fixtureRuntime,
      label: 'generation-v23-refused-dispose',
      protocolVersion: 23,
      refuseDispose: true
    })
    generations.push(generation)
    const canary = await spawnGenerationCanary({
      runtime: fixtureRuntime,
      generation,
      role: 'live'
    })
    canaries.push(canary)
    const shutdownClient = new DaemonClient({
      socketPath: generation.socketPath,
      tokenPath: generation.tokenPath,
      protocolVersion: generation.protocolVersion
    })
    await shutdownClient.ensureConnected()

    const startedAt = Date.now()
    await expect(shutdownClient.request('shutdown', { killSessions: true })).resolves.toEqual({})
    shutdownClient.disconnect()
    expect(Date.now() - startedAt).toBeLessThan(15_000)
    await waitForCondition('shutdown-dispose-failed log', () =>
      generation.logEvents().some((event) => event.event === 'shutdown-dispose-failed')
    )
    const lateClient = new DaemonClient({
      socketPath: generation.socketPath,
      tokenPath: generation.tokenPath,
      protocolVersion: generation.protocolVersion
    })
    await expect(lateClient.ensureConnected()).rejects.toThrow()
    lateClient.disconnect()
    const fencedLiveness = await collectLiveness(generations, canaries)
    // Why: disposal failure may strand the fixture process, but fencing must
    // remove authority without pretending that the retained PTY disappeared.
    expect(fencedLiveness.daemons[generation.label]).toBe(true)
    expect(fencedLiveness.roots[canaryLabel(canary)]).toBe(true)
    expect(fencedLiveness.descendants[canaryLabel(canary)]).toBe(true)
    expect(generation.logEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: 'shutdown', reason: 'rpc', killSessions: true }),
        expect.objectContaining({ event: 'shutdown-dispose-failed' })
      ])
    )
    assertionsComplete = true
  } finally {
    await cleanupGenerationTestFixtures({
      runtime: fixtureRuntime,
      generations,
      canaries,
      retainDiagnostics: !assertionsComplete
    })
  }
})
