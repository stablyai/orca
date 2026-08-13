/**
 * Journey 6: Docker OpenSSH with `MaxSessions=1`.
 *
 * The container's sshd permits exactly one concurrent session channel per
 * network connection, which is what makes a multiplexing failure observable
 * rather than silent: anything that needs a second channel must open a second
 * connection, and the connection census sees it.
 *
 * Four clauses, one test each, all independent (own container, own profile), so
 * a red one cannot report the others as "did not run":
 *
 *   1. A transport disconnect keeps the same remote PID and the exact binding.
 *   2. A client restart keeps the same remote PID and the exact binding.
 *   3. An authority reconnect holding a lease no durable pane owns leaves that
 *      shell running and unbound instead of grafting the pane back.
 *   4. A restarted authority imports the owned panes exactly and leaves the
 *      unresolved one visible and recoverable rather than killing it.
 *
 * Why 3 and 4 are separate tests and not one: after a client restart the unowned
 * PTY has no consumer left in the new process, so its source recovery cannot
 * complete and the reattach returns before the binding write. The graft risk
 * that `mayCreate: false` fences is therefore only reachable on 3, and 4 is a
 * forward guard for that clause while remaining a real oracle for "imports
 * exactly" and "destroys nothing".
 *
 * The PID is read on the container twice over, and both readings must agree:
 * the pane's own shell reports `$$` through the production write path onto the
 * container filesystem, and a /proc census reports the pid the relay hosts for
 * that pane key. Each pid carries its kernel start time, so a recycled pid
 * cannot pass as a survivor — ids matching proves nothing.
 *
 * Discrimination, measured rather than asserted. Two guard removals each redden
 * one clause and leave the others green in the same run:
 *   A. `src/main/ssh/ssh-relay-session.ts` `restoreReattachedPtyRuntime` — drop
 *      `mayCreate: false` from the reattach binding write. Test 3 fails with the
 *      unowned leaf grafted into the `local` partition; tests 1, 2 and 4 pass.
 *   C. `ssh-relay-session.ts` `beginShutdownDetach` — mark leases `terminated`
 *      instead of `detached` at quit, the classic unknown-treated-as-dead. Tests
 *      2 and 4 fail with a cold-spawned shell beside the surviving one; tests 1
 *      and 3 pass.
 *
 * Test 1 is a forward guard, stated plainly. Two further removals left it green:
 * publishing `SSH_SESSION_EXPIRED` in place of `SSH_SOURCE_RESTORE_REQUIRED`
 * (`ssh-pty-provider.ts`), and making `isProvenSshSessionGoneError` return true
 * for every error. Neither is reachable here, because a sever that leaves the
 * detached relay holding its delivery record reattaches through the checkpoint
 * path and no reattach failure is ever classified. Inducing `restoreRequired`
 * needs a lost or mismatched delivery record, which this fault does not produce.
 *
 * Run with an isolated TMPDIR: `global-setup.ts` keys its seeded-repo pointer on
 * a machine-global tmpdir path, so a concurrent run can both fabricate and mask
 * a red.
 */
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { test, expect } from './helpers/orca-app'
import { createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot,
  type PaneIdentitySnapshot
} from './helpers/terminal'
import { readDurablePaneBindings, sshExecutionHostId } from './helpers/remote-pane-durable-session'
import { seedUnboundRemotePtyLease } from './helpers/unbound-remote-pty-lease'
import {
  findSshRemotePtyLeaseForLeaf,
  readSshRemotePtyLeases,
  resolveOrcaProfileStateFile
} from './helpers/ssh-remote-pty-lease-file'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  reconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import { severDockerSshRelayTransport } from './helpers/docker-ssh-relay-processes'
import {
  countDockerSshRelayRemoteStreamWriters,
  readDockerSshRelayRemotePtys
} from './helpers/docker-ssh-relay-remote-ptys'
import { readDockerSshdSessionCap } from './helpers/docker-ssh-relay-sshd-session-cap'
import { readRemoteShellPid } from './helpers/docker-ssh-remote-shell-pid'
import {
  bindingIdentityOf,
  describeRemoteWorkspaceCensus,
  readRemoteWorkspaceCensus,
  type RemoteWorkspaceCensus,
  type RemoteWorkspaceCensusScope
} from './helpers/docker-ssh-relay-workspace-census'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const MAX_SESSIONS = 1
const PANE_COUNT = 2
// Why: the relay must outlive every fault. If it exits with the client the
// remote shells die too and reconnect degrades to a cold spawn, which is not
// the path this journey bounds.
const RELAY_GRACE_PERIOD_SECONDS = 900
// Why: a graft or a late respawn lands after reattach reports ready, so every
// dimension is re-read once the dust settles rather than the instant a wait passes.
const SETTLE_MS = 6_000

test.use({ seedTestRepo: false })

type PaneShellIdentity = {
  leafId: string
  ptyId: string
  /** Reported by the shell itself and confirmed by the container's /proc census. */
  pid: number
  startTicks: number
}

async function waitForSshConnected(page: Page, targetId: string, timeoutMs: number): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          async (targetId) => (await window.api.ssh.getState({ targetId }))?.status ?? null,
          targetId
        ),
      { timeout: timeoutMs, message: 'SSH target never reported itself connected' }
    )
    .toBe('connected')
}

/**
 * Ask every pane's shell for its own pid and confirm it against the pid the
 * relay hosts for that pane key. Disagreement means the pane is writing to a
 * process other than the one the host attributes to it.
 */
async function readPaneShellIdentities(
  page: Page,
  target: DockerSshRelayTarget,
  snapshot: PaneIdentitySnapshot,
  phase: string
): Promise<PaneShellIdentity[]> {
  const identities: PaneShellIdentity[] = []
  for (const pane of snapshot.panes) {
    if (!pane.ptyId) {
      throw new Error(`Pane ${pane.leafId} has no PTY to ask`)
    }
    const reportedPid = await readRemoteShellPid(page, target, {
      ptyId: pane.ptyId,
      probePath: `/tmp/orca-j6-shell-pid-${phase}-${pane.leafId}`
    })
    const paneKey = `${snapshot.tabId}:${pane.leafId}`
    const hosted = readDockerSshRelayRemotePtys(target).find((pty) => pty.paneKey === paneKey)
    if (!hosted) {
      throw new Error(`The relay hosts no remote shell for pane ${paneKey}`)
    }
    expect(
      hosted.pid,
      `pane ${paneKey} answered from a process the relay does not host for it`
    ).toBe(reportedPid)
    identities.push({
      leafId: pane.leafId,
      ptyId: pane.ptyId,
      pid: reportedPid,
      startTicks: hosted.startTicks
    })
  }
  return identities.sort((left, right) => left.leafId.localeCompare(right.leafId))
}

type StreamingRemoteWorkspace = {
  remote: Awaited<ReturnType<typeof connectDockerSshRelayTarget>>
  snapshot: PaneIdentitySnapshot
  scope: RemoteWorkspaceCensusScope
}

/**
 * A connected remote workspace with PANE_COUNT panes, each carrying a live
 * output source. Why every pane must stream: an idle pane reattaches as
 * 'existing' and never enters the source re-establishment that used to read as
 * expiry and respawn the shell. The writer is backgrounded so the shell keeps
 * its prompt and can still answer for its own pid after a fault.
 */
async function openStreamingRemotePanes(
  page: Page,
  app: ElectronApplication,
  target: DockerSshRelayTarget
): Promise<StreamingRemoteWorkspace> {
  await waitForSessionReady(page)
  const remote = await connectDockerSshRelayTarget(page, target, {
    relayGracePeriodSeconds: RELAY_GRACE_PERIOD_SECONDS
  })
  await expect.poll(() => waitForActiveWorktree(page), { timeout: 30_000 }).toBe(remote.worktreeId)
  await ensureTerminalVisible(page, 45_000)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)

  await splitActiveTerminalPane(page, 'vertical')
  const snapshot = await waitForPaneIdentitySnapshot(page, PANE_COUNT)

  const streamMarker = `SSH_MAXSESSIONS_STREAM_${Date.now()}`
  for (const pane of snapshot.panes) {
    if (!pane.ptyId) {
      throw new Error(`Pane ${pane.leafId} has no PTY to stream from`)
    }
    await sendToTerminal(
      page,
      pane.ptyId,
      `node -e "setInterval(()=>process.stdout.write('${streamMarker}_'+Date.now()+'\\n'),100)" &\r`
    )
  }
  await expect
    .poll(() => countDockerSshRelayRemoteStreamWriters(target, streamMarker), {
      timeout: 60_000,
      message: 'remote panes did not start streaming before the first fault'
    })
    .toBe(PANE_COUNT)
  await expect
    .poll(() => readDockerSshRelayRemotePtys(target).length, {
      timeout: 60_000,
      message: 'remote shells did not settle at one per pane'
    })
    .toBe(PANE_COUNT)

  return {
    remote,
    snapshot,
    scope: {
      target,
      hostId: sshExecutionHostId(remote.targetId),
      worktreeId: remote.worktreeId,
      targetId: remote.targetId,
      stateFile: await resolveOrcaProfileStateFile(app)
    }
  }
}

/** Persist the renderer snapshot the way a real quit does, then prove it landed. */
async function persistBeforeQuit(page: Page, targetId: string, worktreeId: string): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
  await expect
    .poll(
      () =>
        page.evaluate(
          async ({ targetId, worktreeId }) => {
            const persisted = await window.api.session.get()
            return (
              persisted.activeConnectionIdsAtShutdown?.includes(targetId) === true &&
              (persisted.tabsByWorktree[worktreeId]?.length ?? 0) > 0
            )
          },
          { targetId, worktreeId }
        ),
      { timeout: 15_000, message: 'the SSH workspace was not persisted before quit' }
    )
    .toBe(true)
}

async function settleRestoredRemoteWorkspace(
  page: Page,
  remote: { targetId: string; worktreeId: string }
): Promise<PaneIdentitySnapshot> {
  await waitForSessionReady(page, 60_000)
  await expect.poll(() => waitForActiveWorktree(page), { timeout: 60_000 }).toBe(remote.worktreeId)
  await waitForSshConnected(page, remote.targetId, 120_000)
  await ensureTerminalVisible(page, 45_000)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
  return waitForPaneIdentitySnapshot(page, PANE_COUNT)
}

function expectSameShells(actual: PaneShellIdentity[], expected: PaneShellIdentity[]): void {
  expect(
    actual.map((identity) => `${identity.leafId}=${identity.pid}@${identity.startTicks}`),
    'a pane is bound to a different remote process than before the fault'
  ).toEqual(expected.map((identity) => `${identity.leafId}=${identity.pid}@${identity.startTicks}`))
}

function expectCapSlotsBounded(
  census: RemoteWorkspaceCensus,
  baseline: RemoteWorkspaceCensus,
  label: string
): void {
  // Why a bound and not equality: under MaxSessions=1 every concurrent host
  // operation legitimately needs its own connection, so the count breathes. A
  // leak is monotone growth, and at least one connection must remain or the
  // relay bridge is gone.
  expect(census.sshdConnectionCount, `${label} left no SSH connection to the host`).toBeGreaterThan(
    0
  )
  expect(census.sshdConnectionCount, `${label} leaked SSH session-cap slots`).toBeLessThanOrEqual(
    baseline.sshdConnectionCount
  )
}

type UnownedRemotePty = {
  leafId: string
  ptyId: string
  attachedAt: number
  /** Census taken with the unowned shell already live, so it is part of the baseline. */
  baseline: RemoteWorkspaceCensus
}

/** `leafId -> lastAttachedAt` for every live lease on the target. */
function readLeaseAttachStamps(stateFile: string, targetId: string): Record<string, number> {
  return Object.fromEntries(
    readSshRemotePtyLeases(stateFile, targetId).map((lease) => [
      lease.leafId ?? '-',
      lease.lastAttachedAt ?? 0
    ])
  )
}

/**
 * The divergence this journey's third clause is about: a live lease and a live
 * remote shell that no durable pane names. Seeded rather than induced — closing
 * a pane over a downed link takes `pty:kill`'s tombstone branch instead, and
 * every oracle downstream then passes vacuously.
 */
async function seedUnownedStreamingRemotePty(
  page: Page,
  target: DockerSshRelayTarget,
  workspace: StreamingRemoteWorkspace
): Promise<UnownedRemotePty> {
  const { remote, snapshot, scope } = workspace
  const unbound = await seedUnboundRemotePtyLease(page, {
    targetId: remote.targetId,
    hostId: scope.hostId,
    worktreeId: remote.worktreeId,
    tabId: snapshot.tabId,
    leafId: randomUUID()
  })
  const marker = `SSH_MAXSESSIONS_UNOWNED_${Date.now()}`
  await sendToTerminal(
    page,
    unbound.ptyId,
    `node -e "setInterval(()=>process.stdout.write('${marker}_'+Date.now()+'\\n'),100)" &\r`
  )
  await expect
    .poll(() => countDockerSshRelayRemoteStreamWriters(target, marker), {
      timeout: 60_000,
      message: 'the unowned remote PTY never started streaming'
    })
    .toBe(1)
  await expect
    .poll(() => readDockerSshRelayRemotePtys(target).length, {
      timeout: 60_000,
      message: 'the relay did not settle at one shell per pane plus the unowned one'
    })
    .toBe(PANE_COUNT + 1)

  // The unowned shell is the pane-key-less one: ORCA_PANE_KEY is injected by the
  // pane launch path, which a leaf that never becomes a pane never runs.
  expect(
    readDockerSshRelayRemotePtys(target).filter((pty) => pty.paneKey === null),
    'the unowned remote shell is not separable from the pane-owned ones'
  ).toHaveLength(1)
  const lease = findSshRemotePtyLeaseForLeaf(scope.stateFile, remote.targetId, unbound.leafId)
  expect(lease?.state, 'the unowned remote PTY never took a live lease').toBe('attached')
  const baseline = await readRemoteWorkspaceCensus(page, scope)
  expect(
    baseline.durableBindings.filter((binding) => binding.includes(unbound.leafId)),
    'no durable partition may name the unowned leaf'
  ).toHaveLength(0)
  return {
    leafId: unbound.leafId,
    ptyId: unbound.ptyId,
    attachedAt: lease?.lastAttachedAt ?? 0,
    baseline
  }
}

/** A graft can land and be overwritten by a later renderer snapshot, so sample
 *  continuously: a poll that needs one matching read would miss it. */
async function expectDurableBindingsHoldFor(
  page: Page,
  scope: RemoteWorkspaceCensusScope,
  expected: string[],
  windowMs: number
): Promise<void> {
  const deadline = Date.now() + windowMs
  let samples = 0
  while (Date.now() < deadline) {
    expect(
      await readDurablePaneBindings(page, scope.hostId, scope.worktreeId),
      'a durable pane was grafted for a lease no pane owns'
    ).toEqual(expected)
    samples += 1
    await page.waitForTimeout(500)
  }
  expect(samples).toBeGreaterThan(10)
}

test.describe('Docker OpenSSH MaxSessions=1 remote PID and binding identity', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH journeys use POSIX SSH tooling.')

  test('the same remote PID and exact binding survive a transport disconnect', async (// oxlint-disable-next-line no-empty-pattern -- this test owns its Electron launch.
  {}, testInfo: TestInfo) => {
    test.setTimeout(600_000)
    const session = createRestartSession(testInfo)
    let target: DockerSshRelayTarget | null = null
    let app: ElectronApplication | null = null
    try {
      target = startDockerSshRelayTarget(testInfo, { sshdMaxSessions: MAX_SESSIONS })
      const relayTarget = target
      expect(
        readDockerSshdSessionCap(relayTarget).maxSessions,
        'the container did not enforce the session cap this journey is about'
      ).toBe(MAX_SESSIONS)

      const launch = await session.launch()
      app = launch.app
      const { remote, snapshot, scope } = await openStreamingRemotePanes(
        launch.page,
        launch.app,
        relayTarget
      )
      const baselineShells = await readPaneShellIdentities(
        launch.page,
        relayTarget,
        snapshot,
        'boot'
      )
      const baseline = await readRemoteWorkspaceCensus(launch.page, scope)
      expect(baseline.paneIds).toHaveLength(PANE_COUNT)
      testInfo.annotations.push({
        type: 'maxsessions-disconnect-baseline',
        description: describeRemoteWorkspaceCensus(baseline)
      })

      severDockerSshRelayTransport(relayTarget)
      await waitForSshConnected(launch.page, remote.targetId, 180_000)
      await ensureTerminalVisible(launch.page, 45_000)
      await waitForActiveTerminalManager(launch.page, 60_000)
      await waitForActivePanePtyId(launch.page, 60_000)

      await expect
        .poll(async () => bindingIdentityOf(await readRemoteWorkspaceCensus(launch.page, scope)), {
          timeout: 120_000,
          message: 'the transport disconnect changed the remote shells, panes, bindings or leases'
        })
        .toEqual(bindingIdentityOf(baseline))

      // Poll returns on its first passing probe, so sit out the settle window
      // and re-read every dimension a late graft or respawn could still move.
      await launch.page.waitForTimeout(SETTLE_MS)
      const settled = await readRemoteWorkspaceCensus(launch.page, scope)
      expect(
        bindingIdentityOf(settled),
        'the transport disconnect changed the workspace after settling'
      ).toEqual(bindingIdentityOf(baseline))
      expectCapSlotsBounded(settled, baseline, 'the transport disconnect')

      const reconnectedSnapshot = await waitForPaneIdentitySnapshot(launch.page, PANE_COUNT)
      expectSameShells(
        await readPaneShellIdentities(launch.page, relayTarget, reconnectedSnapshot, 'reconnect'),
        baselineShells
      )
      testInfo.annotations.push({
        type: 'maxsessions-disconnect-settled',
        description: describeRemoteWorkspaceCensus(settled)
      })
    } finally {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })

  test('the same remote PID and exact binding survive a client restart', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches.
  {}, testInfo: TestInfo) => {
    test.setTimeout(600_000)
    const session = createRestartSession(testInfo)
    let target: DockerSshRelayTarget | null = null
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null
    try {
      target = startDockerSshRelayTarget(testInfo, { sshdMaxSessions: MAX_SESSIONS })
      const relayTarget = target
      expect(readDockerSshdSessionCap(relayTarget).maxSessions).toBe(MAX_SESSIONS)

      const first = await session.launch()
      firstApp = first.app
      const { remote, snapshot, scope } = await openStreamingRemotePanes(
        first.page,
        first.app,
        relayTarget
      )
      const baselineShells = await readPaneShellIdentities(
        first.page,
        relayTarget,
        snapshot,
        'boot'
      )
      const baseline = await readRemoteWorkspaceCensus(first.page, scope)
      expect(baseline.paneIds).toHaveLength(PANE_COUNT)
      testInfo.annotations.push({
        type: 'maxsessions-restart-baseline',
        description: describeRemoteWorkspaceCensus(baseline)
      })

      await persistBeforeQuit(first.page, remote.targetId, remote.worktreeId)
      await session.close(firstApp)
      firstApp = null

      const second = await session.launch()
      secondApp = second.app
      const restoredSnapshot = await settleRestoredRemoteWorkspace(second.page, remote)

      await expect
        .poll(async () => bindingIdentityOf(await readRemoteWorkspaceCensus(second.page, scope)), {
          timeout: 120_000,
          message: 'the client restart changed the remote shells, panes, bindings or leases'
        })
        .toEqual(bindingIdentityOf(baseline))

      await second.page.waitForTimeout(SETTLE_MS)
      const settled = await readRemoteWorkspaceCensus(second.page, scope)
      expect(
        bindingIdentityOf(settled),
        'the client restart changed the workspace after settling'
      ).toEqual(bindingIdentityOf(baseline))
      expectCapSlotsBounded(settled, baseline, 'the client restart')

      expectSameShells(
        await readPaneShellIdentities(second.page, relayTarget, restoredSnapshot, 'restart'),
        baselineShells
      )
      testInfo.annotations.push({
        type: 'maxsessions-restart-settled',
        description: describeRemoteWorkspaceCensus(settled)
      })
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })

  // Unknown is not dead. Reconnecting an authority that still holds the
  // unowned PTY's consumer is where the graft risk lives: the reattach reaches
  // the binding write, and a write allowed to create would surface a pane the
  // user never opened.
  test('an authority reconnect leaves an unowned remote shell running and unbound', async (// oxlint-disable-next-line no-empty-pattern -- this test owns its Electron launch.
  {}, testInfo: TestInfo) => {
    test.setTimeout(600_000)
    const session = createRestartSession(testInfo)
    let target: DockerSshRelayTarget | null = null
    let app: ElectronApplication | null = null
    try {
      target = startDockerSshRelayTarget(testInfo, { sshdMaxSessions: MAX_SESSIONS })
      const relayTarget = target
      expect(readDockerSshdSessionCap(relayTarget).maxSessions).toBe(MAX_SESSIONS)

      const launch = await session.launch()
      app = launch.app
      const workspace = await openStreamingRemotePanes(launch.page, launch.app, relayTarget)
      const { remote, scope } = workspace
      const unowned = await seedUnownedStreamingRemotePty(launch.page, relayTarget, workspace)
      testInfo.annotations.push({
        type: 'maxsessions-authority-reconnect-seeded',
        description: describeRemoteWorkspaceCensus(unowned.baseline)
      })

      // Why an explicit disconnect and not a transport sever: only the detach
      // path moves the lease attached -> detached, which makes the flip back to
      // attached positive proof that the reattach reached this exact lease.
      await reconnectDockerSshRelayTarget(launch.page, remote.targetId)
      await waitForSshConnected(launch.page, remote.targetId, 180_000)
      await ensureTerminalVisible(launch.page, 45_000)
      await waitForActiveTerminalManager(launch.page, 60_000)
      await waitForActivePanePtyId(launch.page, 60_000)

      // Vacuity guard: without it a reattach that silently skipped the lease
      // would be indistinguishable from one that correctly refused to bind it.
      await expect
        .poll(
          () =>
            findSshRemotePtyLeaseForLeaf(scope.stateFile, remote.targetId, unowned.leafId)
              ?.lastAttachedAt ?? 0,
          {
            timeout: 180_000,
            message: 'the reconnect never reattached the unowned lease, so the census is vacuous'
          }
        )
        .toBeGreaterThan(unowned.attachedAt)

      await expectDurableBindingsHoldFor(
        launch.page,
        scope,
        unowned.baseline.durableBindings,
        25_000
      )

      const settled = await readRemoteWorkspaceCensus(launch.page, scope)
      expect(settled.remoteShells, 'the reconnect killed or respawned a remote shell').toEqual(
        unowned.baseline.remoteShells
      )
      expect(settled.paneIds, 'the reconnect surfaced a pane the user never opened').toEqual(
        unowned.baseline.paneIds
      )
      expect(settled.tabIds, 'the reconnect changed the workspace tabs').toEqual(
        unowned.baseline.tabIds
      )
      expectCapSlotsBounded(settled, unowned.baseline, 'the authority reconnect')
      testInfo.annotations.push({
        type: 'maxsessions-authority-reconnect-settled',
        description: describeRemoteWorkspaceCensus(settled)
      })
    } finally {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })

  // The other half of the journey's disjunction: a restarted authority imports
  // the panes it can place exactly, and the one it cannot place stays visible
  // and recoverable — its lease is not retired and its shell is not killed.
  test('a restarted authority imports the owned panes exactly and leaves unresolved ownership intact', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches.
  {}, testInfo: TestInfo) => {
    test.setTimeout(600_000)
    const session = createRestartSession(testInfo)
    let target: DockerSshRelayTarget | null = null
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null
    try {
      target = startDockerSshRelayTarget(testInfo, { sshdMaxSessions: MAX_SESSIONS })
      const relayTarget = target
      expect(readDockerSshdSessionCap(relayTarget).maxSessions).toBe(MAX_SESSIONS)

      const first = await session.launch()
      firstApp = first.app
      const workspace = await openStreamingRemotePanes(first.page, first.app, relayTarget)
      const { remote, snapshot, scope } = workspace
      const paneShellsBeforeQuit = await readPaneShellIdentities(
        first.page,
        relayTarget,
        snapshot,
        'boot'
      )
      const unowned = await seedUnownedStreamingRemotePty(first.page, relayTarget, workspace)
      const attachStampsBeforeQuit = readLeaseAttachStamps(scope.stateFile, remote.targetId)
      testInfo.annotations.push({
        type: 'maxsessions-restart-unresolved-seeded',
        description: describeRemoteWorkspaceCensus(unowned.baseline)
      })

      await persistBeforeQuit(first.page, remote.targetId, remote.worktreeId)
      await session.close(firstApp)
      firstApp = null

      const second = await session.launch()
      secondApp = second.app
      const restoredSnapshot = await settleRestoredRemoteWorkspace(second.page, remote)

      // Positive proof the restarted authority ran its reattach fan-out over
      // this target: every owned lease carries a fresh attach stamp. The fan-out
      // iterates the lease inventory, so the unowned lease was in the same pass.
      await expect
        .poll(
          () => {
            const stamps = readLeaseAttachStamps(scope.stateFile, remote.targetId)
            return restoredSnapshot.panes.every(
              (pane) => (stamps[pane.leafId] ?? 0) > (attachStampsBeforeQuit[pane.leafId] ?? 0)
            )
          },
          {
            timeout: 180_000,
            message: 'the restarted authority never reattached the owned leases'
          }
        )
        .toBe(true)

      // Imports exactly: same remote processes, same panes, same bindings.
      expectSameShells(
        await readPaneShellIdentities(second.page, relayTarget, restoredSnapshot, 'restart'),
        paneShellsBeforeQuit
      )
      await expectDurableBindingsHoldFor(
        second.page,
        scope,
        unowned.baseline.durableBindings,
        25_000
      )

      // Unresolved, not dead: the lease is still there, in a state that can be
      // resolved later, and its remote shell is untouched.
      const unownedLease = findSshRemotePtyLeaseForLeaf(
        scope.stateFile,
        remote.targetId,
        unowned.leafId
      )
      expect(unownedLease, 'the restarted authority dropped the unowned lease').toBeDefined()
      expect(
        unownedLease?.state,
        'the restarted authority retired a lease whose ownership is only unknown'
      ).not.toBe('terminated')
      expect(unownedLease?.state).not.toBe('expired')

      const settled = await readRemoteWorkspaceCensus(second.page, scope)
      expect(
        settled.remoteShells,
        'the restarted authority killed or respawned a remote shell'
      ).toEqual(unowned.baseline.remoteShells)
      expect(
        settled.paneIds,
        'the restarted authority surfaced a pane the user never opened'
      ).toEqual(unowned.baseline.paneIds)
      expect(settled.tabIds, 'the restarted authority changed the workspace tabs').toEqual(
        unowned.baseline.tabIds
      )
      expectCapSlotsBounded(settled, unowned.baseline, 'the authority restart')
      testInfo.annotations.push({
        type: 'maxsessions-restart-unresolved-settled',
        description: `${describeRemoteWorkspaceCensus(settled)} unownedLease=${unownedLease?.state}`
      })
    } finally {
      if (secondApp) {
        await session.close(secondApp)
      }
      if (firstApp) {
        await session.close(firstApp)
      }
      await session.dispose()
      cleanupDockerSshRelayTarget(target)
    }
  })
})
