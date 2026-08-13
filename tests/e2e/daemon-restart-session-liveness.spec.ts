/**
 * Journey 2 (daemon half): the same PTY — the same *OS shell process* — must
 * survive both a client restart and a daemon restart, and an operation carrying
 * a stale daemon generation must be refused without killing or replacing the
 * live successor.
 *
 * What "daemon restart" means here, precisely: the PTY leader is a child of the
 * daemon that spawned it, so a same-generation daemon exit takes its shells with
 * it. The only PTY-preserving daemon restart Orca has is generation succession —
 * a new protocol generation becomes `current` while the generation holding live
 * sessions is preserved and stays reachable through a legacy adapter. That is
 * the boundary these tests cross.
 *
 * Oracle notes:
 *   - Identity is the OS process: the shell reports its own PID through the
 *     production write path (`DaemonPtyRouter.write` -> daemon -> PTY) and the
 *     PID is then resolved to a kernel start time. A same-id/new-process respawn
 *     passes a session-id check, a `hasPty` check, and an `isReattach` check, and
 *     fails only this one.
 *   - Each phase uses a fresh nonce, because reattach replays scrollback and an
 *     earlier phase's answer is still in the stream.
 *
 * Clause separation is deliberate — one clause per test, so a mutation that
 * reddens one leaves the others green:
 *   1. off-socket inventory reads `unknown`, never `dead`;
 *   2. the same OS shell survives client quit + daemon generation restart;
 *   3. a stale-incarnation operation is refused and the live successor is intact.
 *
 * Discrimination protocol (each guard removal must turn the named test red):
 *   1. `daemon-pty-adapter.ts` `hasPty` -> `return this.activeSessionIds.has(id)`
 *      → test 1 fails (a disconnected daemon makes a live session read dead);
 *      tests 2 and 3 stay green.
 *   2. `daemon-session-owner-resolution.ts` `resolveInventory` — drop
 *      `!expectedIncarnationIsAuthoritative &&` from the sole-provider fallback
 *      → test 3 fails (the stale-generation operation is applied); tests 1 and 2
 *      stay green.
 */

import { randomUUID } from 'node:crypto'
import { expect, test, type TestInfo } from '@playwright/test'
import { DaemonPtyAdapter } from '../../src/main/daemon/daemon-pty-adapter'
import { DaemonPtyRouter } from '../../src/main/daemon/daemon-pty-router'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'
import {
  cleanupDaemonGenerationFixtures,
  createDaemonGenerationRuntime,
  launchDaemonGeneration,
  type DaemonGeneration,
  type DaemonGenerationRuntime
} from './helpers/daemon-generation-safety-fixtures'
import {
  processIdentityLiveness,
  type RecordedProcessIdentity
} from './helpers/daemon-generation-processes'
import {
  disposeDaemonShellSessions,
  readShellProcessIdentity,
  recordSessionOutput,
  spawnDaemonShellSession,
  type DaemonShellSession
} from './helpers/daemon-shell-process-identity'

/** The generation that already holds live shells when the newer one starts. */
const PRESERVED_PROTOCOL_VERSION = 23

type ReattachOptions = { cwd: string; expectedIncarnationId?: string }

/** Rebuilds exactly what a restarted app constructs: cold adapters, no route, no inventory. */
function restartedAppRouter(generations: readonly DaemonGeneration[]): {
  router: DaemonPtyRouter
  adapters: DaemonPtyAdapter[]
} {
  const adapters = generations.map(
    (generation) =>
      new DaemonPtyAdapter({
        socketPath: generation.socketPath,
        tokenPath: generation.tokenPath,
        protocolVersion: generation.protocolVersion
      })
  )
  const current = adapters[0]!
  return {
    router: new DaemonPtyRouter({ current, legacy: adapters.slice(1) }),
    adapters
  }
}

/** Models the app process going away while the daemon keeps the PTY. */
async function quitAppSideOf(shell: DaemonShellSession): Promise<void> {
  await shell.adapter.disconnectOnly()
  shell.adapter.dispose()
}

/** The production reattach: attach-only, never a create. */
async function reattach(
  router: DaemonPtyRouter,
  sessionId: string,
  options: ReattachOptions
): Promise<{ id: string; isReattach?: boolean }> {
  return await router.spawn({
    sessionId,
    isNewSession: false,
    attachOnly: true,
    cols: 200,
    rows: 30,
    cwd: options.cwd,
    ...(options.expectedIncarnationId === undefined
      ? {}
      : {
          expectedIncarnationId: options.expectedIncarnationId,
          expectedIncarnationIsAuthoritative: true
        })
  })
}

/** Every session this daemon generation actually created or attached. */
function sessionOwnershipEvents(generation: DaemonGeneration, sessionId: string): string[] {
  return generation
    .logEvents()
    .filter(
      (event) =>
        event.sessionId === sessionId &&
        (event.event === 'session-created' || event.event === 'session-attached')
    )
    .map((event) => String(event.event))
}

async function inspectionVerdict(router: DaemonPtyRouter, sessionId: string): Promise<string> {
  try {
    await router.inspectProcess(sessionId)
    return 'resolved'
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Exact incarnation, not just the PID: a recycled PID must not read as alive. */
async function shellLeaderIsAlive(shell: DaemonShellSession): Promise<boolean> {
  const liveness = await processIdentityLiveness([shell.rootIdentity])
  return liveness.get(shell.rootIdentity.pid) === true
}

/** Reads the shell's own PID through the router — the production write path. */
async function shellIdentityThroughRouter(
  router: DaemonPtyRouter,
  shell: DaemonShellSession,
  phase: string
): Promise<RecordedProcessIdentity> {
  const recorder = recordSessionOutput(router, shell.sessionId)
  try {
    return await readShellProcessIdentity({
      phase,
      write: (data) => router.write(shell.sessionId, data),
      readOutput: recorder.text
    })
  } finally {
    recorder.stop()
  }
}

async function cleanup(options: {
  runtime: DaemonGenerationRuntime
  generations: readonly DaemonGeneration[]
  shells: readonly DaemonShellSession[]
  adapters: readonly DaemonPtyAdapter[]
  retainDiagnostics: boolean
}): Promise<void> {
  for (const adapter of options.adapters) {
    adapter.dispose()
  }
  if (options.retainDiagnostics) {
    options.runtime.retainDiagnostics(options.generations)
  }
  try {
    await disposeDaemonShellSessions(options.shells)
    await cleanupDaemonGenerationFixtures({
      generations: options.generations,
      canaries: []
    })
  } catch (error) {
    options.runtime.retainDiagnostics(options.generations)
    throw error
  }
  options.runtime.remove()
}

test.describe.configure({ mode: 'serial' })

test('a restarted client reads a daemon-held PTY as unknown, never dead', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument before testInfo.
{}, testInfo: TestInfo) => {
  test.setTimeout(180_000)
  const runtime = await createDaemonGenerationRuntime(testInfo)
  const generations: DaemonGeneration[] = []
  const shells: DaemonShellSession[] = []
  let adapters: DaemonPtyAdapter[] = []
  let assertionsComplete = false

  try {
    const daemon = await launchDaemonGeneration({
      runtime,
      label: `generation-v${PROTOCOL_VERSION}`,
      protocolVersion: PROTOCOL_VERSION
    })
    generations.push(daemon)
    const shell = await spawnDaemonShellSession({
      runtime,
      generation: daemon,
      role: 'live'
    })
    shells.push(shell)

    await quitAppSideOf(shell)
    // Ground truth for every assertion below: the shell is still running.
    expect(await shellLeaderIsAlive(shell)).toBe(true)

    const restarted = restartedAppRouter(generations)
    adapters = restarted.adapters
    const { router } = restarted

    // A restarted client has an empty session cache and a socket it has not
    // dialled yet. Absence of evidence is not evidence of absence — the only
    // honest answer is "unknown". Answering false hands the renderer's
    // dead-session reconcile a licence to exit a pane whose shell is running.
    expect(router.hasPty(shell.sessionId)).toBeNull()
    expect(await inspectionVerdict(router, shell.sessionId)).not.toBe('terminal_gone')
    expect(await shellLeaderIsAlive(shell)).toBe(true)
    assertionsComplete = true
  } finally {
    await cleanup({
      runtime,
      generations,
      shells,
      adapters,
      retainDiagnostics: !assertionsComplete
    })
  }
})

test('the same OS shell process survives a client quit and a daemon generation restart', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument before testInfo.
{}, testInfo: TestInfo) => {
  test.setTimeout(180_000)
  const runtime = await createDaemonGenerationRuntime(testInfo)
  const generations: DaemonGeneration[] = []
  const shells: DaemonShellSession[] = []
  let adapters: DaemonPtyAdapter[] = []
  let assertionsComplete = false

  try {
    // The daemon the app is talking to when the shell is created.
    const preserved = await launchDaemonGeneration({
      runtime,
      label: `generation-v${PRESERVED_PROTOCOL_VERSION}`,
      protocolVersion: PRESERVED_PROTOCOL_VERSION
    })
    generations.push(preserved)
    const shell = await spawnDaemonShellSession({
      runtime,
      generation: preserved,
      role: 'live'
    })
    shells.push(shell)

    const bootRecorder = recordSessionOutput(shell.adapter, shell.sessionId)
    const bootIdentity = await readShellProcessIdentity({
      phase: 'BOOT',
      write: (data) => shell.adapter.write(shell.sessionId, data),
      readOutput: bootRecorder.text
    })
    bootRecorder.stop()
    // The PTY leader the daemon reported is the shell that just answered.
    expect(bootIdentity.pid).toBe(shell.spawnPid)

    // --- client restart boundary ---
    await quitAppSideOf(shell)

    // --- daemon restart boundary: a newer generation takes over as `current` ---
    const successor = await launchDaemonGeneration({
      runtime,
      label: `generation-v${PROTOCOL_VERSION}`,
      protocolVersion: PROTOCOL_VERSION
    })
    generations.unshift(successor)

    const restarted = restartedAppRouter(generations)
    adapters = restarted.adapters
    const { router } = restarted

    await router.discoverLegacySessions()
    const reattached = await reattach(router, shell.sessionId, {
      cwd: runtime.rootDir
    })
    expect(reattached).toMatchObject({ id: shell.sessionId, isReattach: true })

    // The whole journey: not the same id, the same *process*. PID plus kernel
    // start time, answered over the new connection by the shell itself.
    expect(await shellIdentityThroughRouter(router, shell, 'AFTER_DAEMON_RESTART')).toEqual(
      bootIdentity
    )

    // Nothing was created or adopted on the new generation.
    expect(sessionOwnershipEvents(successor, shell.sessionId)).toEqual([])
    expect(sessionOwnershipEvents(preserved, shell.sessionId)).toContain('session-attached')
    assertionsComplete = true
  } finally {
    await cleanup({
      runtime,
      generations,
      shells,
      adapters,
      retainDiagnostics: !assertionsComplete
    })
  }
})

test('a stale daemon generation operation is refused and the live successor is neither killed nor replaced', async (// oxlint-disable-next-line no-empty-pattern -- Playwright requires the fixture argument before testInfo.
{}, testInfo: TestInfo) => {
  test.setTimeout(180_000)
  const runtime = await createDaemonGenerationRuntime(testInfo)
  const generations: DaemonGeneration[] = []
  const shells: DaemonShellSession[] = []
  let adapters: DaemonPtyAdapter[] = []
  let assertionsComplete = false

  try {
    const successor = await launchDaemonGeneration({
      runtime,
      label: `generation-v${PROTOCOL_VERSION}`,
      protocolVersion: PROTOCOL_VERSION
    })
    const preserved = await launchDaemonGeneration({
      runtime,
      label: `generation-v${PRESERVED_PROTOCOL_VERSION}`,
      protocolVersion: PRESERVED_PROTOCOL_VERSION
    })
    generations.push(successor, preserved)

    // Two live shells: one held by the preserved generation, one by the
    // successor. Skew has to leave *both* alone.
    const preservedShell = await spawnDaemonShellSession({
      runtime,
      generation: preserved,
      role: 'preserved-live'
    })
    const successorShell = await spawnDaemonShellSession({
      runtime,
      generation: successor,
      role: 'successor-live'
    })
    shells.push(preservedShell, successorShell)

    const bootIdentities = new Map<string, RecordedProcessIdentity>()
    for (const shell of shells) {
      const recorder = recordSessionOutput(shell.adapter, shell.sessionId)
      bootIdentities.set(
        shell.sessionId,
        await readShellProcessIdentity({
          phase: 'BOOT',
          write: (data) => shell.adapter.write(shell.sessionId, data),
          readOutput: recorder.text
        })
      )
      recorder.stop()
      await quitAppSideOf(shell)
    }

    const restarted = restartedAppRouter(generations)
    adapters = restarted.adapters
    const { router } = restarted
    const successorAdapter = adapters[0]!
    await router.discoverLegacySessions()

    // Skew A — an operation aimed at the wrong generation. The successor has
    // never seen this session; it must refuse rather than create a lookalike.
    await expect(successorAdapter.attach(preservedShell.sessionId)).rejects.toThrow()
    expect(sessionOwnershipEvents(successor, preservedShell.sessionId)).toEqual([])

    // Skew B — an attach that carries an authoritative incarnation the owning
    // generation cannot match. Production sends exactly this shape from
    // `src/main/ipc/pty.ts` when runtime state pins the expected incarnation.
    // It must fail closed, not fall back to "the only candidate I can see".
    await expect(
      reattach(router, preservedShell.sessionId, {
        cwd: runtime.rootDir,
        expectedIncarnationId: randomUUID()
      })
    ).rejects.toThrow()
    await expect(
      reattach(router, successorShell.sessionId, {
        cwd: runtime.rootDir,
        expectedIncarnationId: randomUUID()
      })
    ).rejects.toThrow()

    // Refused means refused: neither live shell was killed or replaced. The
    // exact incarnation still reattaches and the original process answers.
    for (const shell of shells) {
      const reattached = await reattach(router, shell.sessionId, {
        cwd: runtime.rootDir,
        expectedIncarnationId: shell.incarnationId
      })
      expect(reattached).toMatchObject({
        id: shell.sessionId,
        isReattach: true
      })
      expect(await shellIdentityThroughRouter(router, shell, 'AFTER_SKEW')).toEqual(
        bootIdentities.get(shell.sessionId)
      )
    }

    // The preserved generation's session never touched the successor, and the
    // successor's own session never migrated to the preserved generation.
    expect(sessionOwnershipEvents(successor, preservedShell.sessionId)).toEqual([])
    expect(sessionOwnershipEvents(preserved, successorShell.sessionId)).toEqual([])
    assertionsComplete = true
  } finally {
    await cleanup({
      runtime,
      generations,
      shells,
      adapters,
      retainDiagnostics: !assertionsComplete
    })
  }
})
