/**
 * Journey 3 — lazy discovery and a restart that skipped a host.
 *
 * Two real OpenSSH containers. Host A stays in use; host B is left offline by
 * the user before the app quits, with two live panes and their remote shells
 * still running on its container. The app then restarts.
 *
 * Three clauses, one per test, so a regression in one of them cannot be hidden
 * by another's failure:
 *
 *  1. NOT PROBED EAGERLY. Startup dials host A (the positive control — without
 *     it, "nothing dialed B" would be vacuous) and never touches host B. That
 *     is measured on B's own container: sshd's cumulative accepted-auth log, a
 *     live census of `sshd: root@` sessions, and a census of Orca's
 *     `relay.js --connect` bridges. No app log line is trusted for this.
 *  2. LAZY REDISCOVERY RESTORES ONLY THAT HOST. Revealing B's workspace is what
 *     dials it, and what comes back is exactly the two panes it had — the same
 *     PTY ids, and the same shells by pid AND kernel start time, each still
 *     answering on its own pane. Ids alone would not notice a look-alike
 *     respawn, so every pane reports its own `$$` back through the production
 *     write path after the restore.
 *  3. NO ADOPTION. Nothing host-current (a local PTY id) and nothing of host A's
 *     is bound to, named under, or running for host B, and A is untouched by
 *     B's late discovery.
 *
 * `mode: 'serial'` with a shared two-launch fixture: a red first test reports
 * the others as "did not run", which is a skip and not a pass. Each test
 * re-establishes what it needs, so any one of them can be run alone.
 *
 * Watched failing (2026-08-08, macOS 26.3.1 arm64, Docker 29.6.1):
 *  - dropping the `disconnected`/`auth-failed` exclusion in
 *    `buildActiveConnectionIdsAtShutdown` reddens test 1 (host B is dialed at
 *    startup: auths 2 -> 3, one sshd session, one relay bridge) and only the
 *    trailing timing assertion of test 2; test 3 stays green when run alone.
 *  - resolving the durable pane owner from the host-current partition instead of
 *    the host's (`resolvePersistedStablePaneOwner`) reddens tests 2 and 3 —
 *    host B's panes never rebind — while test 1 stays green in the same run.
 * No mutation was found that reddens test 3 alone; see the journey write-up.
 */
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, switchToWorktree, waitForSessionReady } from './helpers/store'
import {
  readPaneIdentitySnapshot,
  sendToTerminal,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { readDurablePaneBindings, sshExecutionHostId } from './helpers/remote-pane-durable-session'
import { readDurablePartitionPtyIds } from './helpers/docker-ssh-relay-host-partition'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  shellQuote,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  disconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import { readDockerSshRelayRemotePtys } from './helpers/docker-ssh-relay-remote-ptys'
import {
  describeDockerSshRemoteShellIdentities,
  readDockerSshRemoteShellIdentities,
  type DockerSshRemoteShellIdentity
} from './helpers/docker-ssh-remote-shell-identity'
import {
  describeDockerSshHostProbeObservation,
  readDockerSshHostProbeObservation,
  type DockerSshHostProbeObservation
} from './helpers/docker-ssh-host-probe-observations'
import { createRestartSession } from './helpers/orca-restart'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const PANE_COUNT = 2
// Why: the relay has to outlive the app. If it exited with the client, host B's
// shells would die at quit and "restore the same process" would be untestable.
const RELAY_GRACE_PERIOD_SECONDS = 900
const NO_PROBE_WINDOW_MS = 20_000
const NO_PROBE_SAMPLE_MS = 1_000

test.use({ seedTestRepo: false })

type HostRecord = {
  label: 'A' | 'B'
  target: DockerSshRelayTarget
  targetId: string
  hostId: string
  worktreeId: string
  tabId: string
  tabIds: string[]
  leafIds: string[]
  ptyIdByLeafId: Record<string, string>
  shells: DockerSshRemoteShellIdentity[]
  reportedPidByLeafId: Record<string, number>
  durableBindings: string[]
}

type ProbeSample = {
  observation: DockerSshHostProbeObservation
  rendererStatus: string | null
}

type Journey = {
  page: Page
  hostA: HostRecord
  hostB: HostRecord
  probeBaselineA: DockerSshHostProbeObservation
  probeBaselineB: DockerSshHostProbeObservation
  probeAfterStartupA: DockerSshHostProbeObservation
  startupSamplesB: ProbeSample[]
  shellsBAfterDisconnect: string[]
  shutdownNamesHostB: boolean
}

let journey: Journey | null = null

/**
 * The app's own answer for "am I connected to this host", from both places that
 * hold one: main drops its state entirely on an explicit disconnect (null), so
 * the renderer store — the map that decides what gets reconnected at startup —
 * is read as well.
 */
async function readSshStatus(page: Page, targetId: string): Promise<string | null> {
  return page.evaluate(async (targetId) => {
    const mainStatus = (await window.api.ssh.getState({ targetId }))?.status ?? null
    const storeStatus = window.__store?.getState().sshConnectionStates.get(targetId)?.status ?? null
    return mainStatus === 'connected' || storeStatus === 'connected'
      ? 'connected'
      : (mainStatus ?? storeStatus)
  }, targetId)
}

function ptyIdBelongsToTarget(ptyId: string, targetId: string): boolean {
  return ptyId.startsWith(`ssh:${encodeURIComponent(targetId)}@@`)
}

/**
 * Makes the shell behind one pane say who it is, through `pty.write` — the same
 * path a keystroke takes. Returns the pid the shell reported.
 *
 * Why re-send on every poll: a shell that is mid-prompt or just reattached can
 * swallow the first line, and one lost keystroke would read as a dead pane.
 */
async function reportShellPid(
  page: Page,
  target: DockerSshRelayTarget,
  ptyId: string,
  phase: string
): Promise<number> {
  const stamp = `/tmp/orca-j3-${phase}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  await expect
    .poll(
      async () => {
        await sendToTerminal(page, ptyId, `printf '%s\\n' "$$" > ${stamp}\r`)
        return execDockerSshRelayTargetCommand(
          target,
          `cat ${shellQuote(stamp)} 2>/dev/null || printf ''`
        ).trim()
      },
      {
        timeout: 90_000,
        intervals: [1_000],
        message: `pane ${ptyId} never reported its shell pid (${phase})`
      }
    )
    .toMatch(/^\d+$/)
  return Number(execDockerSshRelayTargetCommand(target, `cat ${shellQuote(stamp)}`).trim())
}

async function readWorktreeTabIds(page: Page, worktreeId: string): Promise<string[]> {
  return page.evaluate(
    (worktreeId) =>
      (window.__store?.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id),
    worktreeId
  )
}

/** Opens one more terminal tab on a remote worktree and waits for its shell. */
async function openExtraRemoteTab(page: Page, worktreeId: string): Promise<string> {
  const tabId = await page.evaluate((worktreeId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    const tab = state.createTab(worktreeId, undefined, undefined, { activate: true })
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  }, worktreeId)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
  return tabId
}

async function closeTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().closeTab(tabId)
  }, tabId)
  await expect
    .poll(
      async () =>
        page.evaluate(
          (tabId) =>
            Object.values(window.__store?.getState().tabsByWorktree ?? {})
              .flat()
              .some((tab) => tab.id === tabId),
          tabId
        ),
      { timeout: 30_000, message: `tab ${tabId} was never closed` }
    )
    .toBe(false)
}

/** Connects one container, opens PANE_COUNT panes, and records their identity. */
async function openHost(
  page: Page,
  label: 'A' | 'B',
  target: DockerSshRelayTarget
): Promise<HostRecord> {
  const remote = await connectDockerSshRelayTarget(page, target, {
    relayGracePeriodSeconds: RELAY_GRACE_PERIOD_SECONDS
  })
  await ensureTerminalVisible(page, 45_000)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
  if (PANE_COUNT > 1) {
    await splitActiveTerminalPane(page, 'vertical')
  }
  const snapshot = await waitForPaneIdentitySnapshot(page, PANE_COUNT)
  const leafIds = snapshot.panes.map((pane) => pane.leafId)
  const ptyIdByLeafId: Record<string, string> = {}
  for (const pane of snapshot.panes) {
    if (!pane.ptyId) {
      throw new Error(`Host ${label} pane ${pane.leafId} has no PTY`)
    }
    ptyIdByLeafId[pane.leafId] = pane.ptyId
  }
  await expect
    .poll(() => readDockerSshRelayRemotePtys(target).length, {
      timeout: 60_000,
      message: `host ${label} did not settle at one remote shell per pane`
    })
    .toBe(PANE_COUNT)

  const reportedPidByLeafId: Record<string, number> = {}
  for (const leafId of leafIds) {
    reportedPidByLeafId[leafId] = await reportShellPid(
      page,
      target,
      ptyIdByLeafId[leafId]!,
      `${label}-before`
    )
  }
  const hostId = sshExecutionHostId(remote.targetId)
  return {
    label,
    target,
    targetId: remote.targetId,
    hostId,
    worktreeId: remote.worktreeId,
    tabId: snapshot.tabId,
    tabIds: await readWorktreeTabIds(page, remote.worktreeId),
    leafIds,
    ptyIdByLeafId,
    shells: readDockerSshRemoteShellIdentities(target),
    reportedPidByLeafId,
    durableBindings: await readDurablePaneBindings(page, hostId, remote.worktreeId)
  }
}

/** The pane→shell map, keyed by leaf id, as `pid@startTicks:bootId`. */
function shellIdentityByLeafId(
  host: HostRecord,
  identities: DockerSshRemoteShellIdentity[]
): Record<string, string> {
  const byLeafId: Record<string, string> = {}
  for (const leafId of host.leafIds) {
    const shell = identities.find((candidate) => candidate.paneKey?.includes(leafId))
    byLeafId[leafId] = shell
      ? `${shell.pid}@${shell.startTicks}:${shell.bootId}`
      : 'no-shell-for-pane'
  }
  return byLeafId
}

/** The surface that needs host B. Safe to call twice; later calls are no-ops. */
async function revealHostB(page: Page, hostB: HostRecord): Promise<void> {
  await switchToWorktree(page, hostB.worktreeId)
  await ensureTerminalVisible(page, 60_000)
  await expect
    .poll(() => readSshStatus(page, hostB.targetId), {
      timeout: 180_000,
      message: 'revealing host B did not trigger its lazy discovery'
    })
    .toBe('connected')
  await waitForActiveTerminalManager(page, 120_000)
  await waitForActivePanePtyId(page, 120_000)
}

function requireJourney(): Journey {
  if (!journey) {
    throw new Error('Journey 3 setup did not complete')
  }
  return journey
}

test.describe.serial('Lazy discovery and skipped-host restart', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH uses POSIX SSH tooling.')

  let targetA: DockerSshRelayTarget | null = null
  let targetB: DockerSshRelayTarget | null = null
  let restart: ReturnType<typeof createRestartSession> | null = null
  let secondApp: ElectronApplication | null = null

  // oxlint-disable-next-line no-empty-pattern -- This journey owns both Electron launches.
  test.beforeAll(async ({}, testInfo: TestInfo) => {
    test.setTimeout(900_000)
    let firstApp: ElectronApplication | null = null
    try {
      targetA = startDockerSshRelayTarget(testInfo)
      targetB = startDockerSshRelayTarget(testInfo)
      restart = createRestartSession(testInfo)

      const first = await restart.launch()
      firstApp = first.app
      await waitForSessionReady(first.page, 60_000)
      const hostA = await openHost(first.page, 'A', targetA)
      const hostB = await openHost(first.page, 'B', targetB)

      // A third pane on host B, in its own tab, that the user closes while the
      // host is offline. Its lease stays live (nothing could prove the remote
      // shell died), so the restore has a session it must NOT bring back.
      const retiredTabId = await openExtraRemoteTab(first.page, hostB.worktreeId)

      // The user goes back to host A and leaves host B offline.
      await switchToWorktree(first.page, hostA.worktreeId)
      await ensureTerminalVisible(first.page, 45_000)
      await disconnectDockerSshRelayTarget(first.page, hostB.targetId)
      await expect
        .poll(() => readSshStatus(first.page, hostB.targetId), {
          timeout: 60_000,
          message: 'host B still reported itself connected after an explicit disconnect'
        })
        .not.toBe('connected')
      // Unknown is not dead: a disconnect must not have destroyed B's shells.
      const shellsBAfterDisconnect = describeDockerSshRemoteShellIdentities(
        readDockerSshRemoteShellIdentities(targetB)
      )

      await closeTab(first.page, retiredTabId)
      hostB.tabIds = await readWorktreeTabIds(first.page, hostB.worktreeId)
      hostB.durableBindings = await readDurablePaneBindings(
        first.page,
        hostB.hostId,
        hostB.worktreeId
      )
      hostB.shells = readDockerSshRemoteShellIdentities(targetB)

      await first.page.evaluate(() => window.dispatchEvent(new Event('beforeunload')))
      // Why the poll waits only on host A: whether the persisted set also names
      // the host the user left offline is the thing under test, so it is
      // recorded here and asserted in the test rather than waited for here.
      await expect
        .poll(
          async () =>
            first.page.evaluate(async (targetIdA) => {
              const session = await window.api.session.get()
              return (session.activeConnectionIdsAtShutdown ?? []).includes(targetIdA)
            }, hostA.targetId),
          { timeout: 20_000, message: 'the host in use was not persisted for reconnect' }
        )
        .toBe(true)
      const shutdownNamesHostB = await first.page.evaluate(async (targetIdB) => {
        const session = await window.api.session.get()
        return (session.activeConnectionIdsAtShutdown ?? []).includes(targetIdB)
      }, hostB.targetId)

      await restart.close(firstApp)
      firstApp = null

      // Counters are read after the quit so anything the relaunch does is new.
      // Why poll: the quit has to have taken every client-held transport with
      // it, or "no new connection to host B" could be satisfied by an old one.
      await expect
        .poll(() => readDockerSshHostProbeObservation(targetB!).transportProcesses, {
          timeout: 60_000,
          message: 'a client SSH transport to host B outlived the app'
        })
        .toEqual([])
      const probeBaselineA = readDockerSshHostProbeObservation(targetA)
      const probeBaselineB = readDockerSshHostProbeObservation(targetB)

      const sampleStartedAt = Date.now()
      const second = await restart.launch()
      secondApp = second.app
      const startupSamplesB: ProbeSample[] = []
      const sampleB = async (): Promise<void> => {
        startupSamplesB.push({
          observation: readDockerSshHostProbeObservation(targetB!),
          rendererStatus: await readSshStatus(second.page, hostB.targetId).catch(() => null)
        })
      }
      await waitForSessionReady(second.page, 120_000)
      // Sample while startup dials host A, then keep sampling past it: a probe
      // that arrives late is still an eager probe.
      await expect
        .poll(
          async () => {
            await sampleB()
            return readSshStatus(second.page, hostA.targetId)
          },
          {
            timeout: 180_000,
            intervals: [NO_PROBE_SAMPLE_MS],
            message: 'host A did not reconnect at startup; the no-probe check would be vacuous'
          }
        )
        .toBe('connected')
      const deadline = Date.now() + NO_PROBE_WINDOW_MS
      while (Date.now() < deadline) {
        await sampleB()
        await second.page.waitForTimeout(NO_PROBE_SAMPLE_MS)
      }
      await sampleB()

      journey = {
        page: second.page,
        hostA,
        hostB,
        probeBaselineA,
        probeBaselineB,
        probeAfterStartupA: readDockerSshHostProbeObservation(targetA),
        startupSamplesB,
        shellsBAfterDisconnect,
        shutdownNamesHostB
      }
      const receipt = [
        `[journey3] host A ${describeDockerSshHostProbeObservation(probeBaselineA)} -> ${describeDockerSshHostProbeObservation(journey.probeAfterStartupA)}`,
        `[journey3] host B ${describeDockerSshHostProbeObservation(probeBaselineB)} -> ${describeDockerSshHostProbeObservation(startupSamplesB.at(-1)!.observation)} over ${startupSamplesB.length} samples in ${Math.round((Date.now() - sampleStartedAt) / 1000)}s`,
        `[journey3] host B shells before quit: ${describeDockerSshRemoteShellIdentities(hostB.shells).join(' ')}`,
        `[journey3] host B pane pids: ${JSON.stringify(hostB.reportedPidByLeafId)}`
      ].join('\n')
      console.log(receipt)
      testInfo.annotations.push({ type: 'journey3-startup', description: receipt })
    } catch (error) {
      if (firstApp && restart) {
        await restart.close(firstApp)
      }
      throw error
    }
  })

  test.afterAll(async () => {
    if (secondApp && restart) {
      await restart.close(secondApp)
    }
    if (restart) {
      await restart.dispose()
    }
    cleanupDockerSshRelayTarget(targetA)
    cleanupDockerSshRelayTarget(targetB)
    journey = null
  })

  test('leaves a configured but unused host unprobed across restart', async () => {
    test.setTimeout(120_000)
    const {
      probeBaselineA,
      probeAfterStartupA,
      probeBaselineB,
      startupSamplesB,
      hostB,
      shutdownNamesHostB
    } = requireJourney()

    expect(
      shutdownNamesHostB,
      'the persisted shutdown set names the host the user left offline, so startup will dial it'
    ).toBe(false)

    // Positive control: startup really does dial the host it was using.
    expect(
      probeAfterStartupA.acceptedAuths,
      'startup did not authenticate to host A, so "host B was not dialed" would prove nothing'
    ).toBeGreaterThan(probeBaselineA.acceptedAuths)

    expect(startupSamplesB.length).toBeGreaterThan(4)
    for (const [index, sample] of startupSamplesB.entries()) {
      expect(
        sample.observation.acceptedAuths,
        `host B was authenticated to at startup (sample ${index})`
      ).toBe(probeBaselineB.acceptedAuths)
      expect(
        sample.observation.sshdSessions,
        `host B had a live sshd session at startup (sample ${index})`
      ).toBe(0)
      expect(
        sample.observation.connectBridges,
        `a relay transport bridge was opened to host B at startup (sample ${index})`
      ).toBe(0)
      expect(
        sample.rendererStatus,
        `the app reported host B as ${sample.rendererStatus} at startup (sample ${index})`
      ).not.toBe('connected')
    }

    // Unknown is not dead, twice over: not at the disconnect, not at the quit.
    expect(
      requireJourney().shellsBAfterDisconnect,
      'disconnecting host B destroyed its remote shells'
    ).toEqual(describeDockerSshRemoteShellIdentities(hostB.shells))
    expect(
      describeDockerSshRemoteShellIdentities(readDockerSshRemoteShellIdentities(hostB.target)),
      'host B lost or gained a remote shell while it was skipped'
    ).toEqual(describeDockerSshRemoteShellIdentities(hostB.shells))
  })

  test('restores exactly the skipped host sessions when its surface is touched', async () => {
    test.setTimeout(600_000)
    const { page, hostB, probeBaselineB } = requireJourney()
    const beforeReveal = readDockerSshHostProbeObservation(hostB.target)

    await revealHostB(page, hostB)

    // Only its own sessions: the tab the user closed while the host was offline
    // still holds a live lease, and it must not be grafted back as UI.
    expect(
      await readWorktreeTabIds(page, hostB.worktreeId),
      'host B came back with a different set of tabs than the user left'
    ).toEqual(hostB.tabIds)

    const snapshot = await readPaneIdentitySnapshot(page)
    expect(snapshot?.tabId, 'host B restored a different tab').toBe(hostB.tabId)
    expect(
      snapshot?.panes.map((pane) => pane.leafId).sort(),
      'host B did not restore exactly its own panes'
    ).toEqual([...hostB.leafIds].sort())
    expect(
      Object.fromEntries(snapshot!.panes.map((pane) => [pane.leafId, pane.ptyId])),
      'host B panes rebound to different PTYs'
    ).toEqual(hostB.ptyIdByLeafId)

    const restoredIdentities = readDockerSshRemoteShellIdentities(hostB.target)
    expect(
      describeDockerSshRemoteShellIdentities(restoredIdentities),
      'host B did not come back with exactly the shells it had'
    ).toEqual(describeDockerSshRemoteShellIdentities(hostB.shells))
    expect(
      shellIdentityByLeafId(hostB, restoredIdentities),
      'a host B pane is served by a different process than before the restart'
    ).toEqual(shellIdentityByLeafId(hostB, hostB.shells))

    // The strongest observable: each pane's own shell answers, and it is the
    // same process — not a look-alike wearing the same ids.
    const reportedPidByLeafId: Record<string, number> = {}
    for (const leafId of hostB.leafIds) {
      reportedPidByLeafId[leafId] = await reportShellPid(
        page,
        hostB.target,
        hostB.ptyIdByLeafId[leafId]!,
        'B-after'
      )
    }
    expect(
      reportedPidByLeafId,
      'a restored host B pane is talking to a different shell process'
    ).toEqual(hostB.reportedPidByLeafId)

    expect(
      await readDurablePaneBindings(page, hostB.hostId, hostB.worktreeId),
      'host B durable pane bindings changed across the skipped restart'
    ).toEqual(hostB.durableBindings)

    // Last, because it is the timing half of the clause rather than the
    // restoration half: the touch is what dialed the host, and nothing before it.
    expect(beforeReveal.acceptedAuths, 'host B was dialed before anything asked for it').toBe(
      probeBaselineB.acceptedAuths
    )
    expect(
      readDockerSshHostProbeObservation(hostB.target).acceptedAuths,
      'revealing host B did not produce a new authentication on its container'
    ).toBeGreaterThan(probeBaselineB.acceptedAuths)
    console.log(
      `[journey3] host B restored: ${describeDockerSshRemoteShellIdentities(restoredIdentities).join(' ')} pids=${JSON.stringify(reportedPidByLeafId)} auths ${probeBaselineB.acceptedAuths} -> ${readDockerSshHostProbeObservation(hostB.target).acceptedAuths}`
    )
  })

  test('adopts neither host-current nor sibling-host state on rediscovery', async () => {
    test.setTimeout(600_000)
    const { page, hostA, hostB } = requireJourney()
    await revealHostB(page, hostB)

    // Every id host B's panes hold names host B.
    const snapshot = await readPaneIdentitySnapshot(page)
    expect(snapshot?.panes.length, 'host B has no panes to check for adoption').toBe(PANE_COUNT)
    for (const pane of snapshot?.panes ?? []) {
      expect(
        pane.ptyId && ptyIdBelongsToTarget(pane.ptyId, hostB.targetId),
        `host B pane ${pane.leafId} is bound to ${pane.ptyId}, which is not host B's`
      ).toBe(true)
    }

    // Nothing of host A's is named anywhere in host B's durable partition, and
    // nothing host-current (a local, unscoped PTY id) either.
    const partitionIds = await readDurablePartitionPtyIds(page, hostB.hostId)
    // Why: an empty partition would satisfy both filters below without proving
    // anything, so the census has to have found host B's own ids first.
    expect(
      partitionIds.length,
      "host B's durable partition named no PTY at all"
    ).toBeGreaterThanOrEqual(PANE_COUNT)
    expect(
      partitionIds.filter((id) => ptyIdBelongsToTarget(id, hostA.targetId)),
      "host A's PTY ids appeared in host B's durable partition"
    ).toEqual([])
    expect(
      partitionIds.filter((id) => !ptyIdBelongsToTarget(id, hostB.targetId)),
      "host B's durable partition names a PTY that is not host B's"
    ).toEqual([])

    // No shell on host B's container claims host A's workspace.
    for (const shell of readDockerSshRemoteShellIdentities(hostB.target)) {
      expect(shell.worktreeId, 'a host A worktree is running on host B').not.toBe(hostA.worktreeId)
      expect(shell.tabId, 'a host A tab is running on host B').not.toBe(hostA.tabId)
    }

    // Host A is untouched by host B's late discovery, and still its own host.
    expect(
      describeDockerSshRemoteShellIdentities(readDockerSshRemoteShellIdentities(hostA.target)),
      "host B's discovery changed host A's remote shells"
    ).toEqual(describeDockerSshRemoteShellIdentities(hostA.shells))
    expect(
      await readDurablePaneBindings(page, hostA.hostId, hostA.worktreeId),
      "host B's discovery changed host A's durable pane bindings"
    ).toEqual(hostA.durableBindings)
    const reportedPidByLeafId: Record<string, number> = {}
    for (const leafId of hostA.leafIds) {
      reportedPidByLeafId[leafId] = await reportShellPid(
        page,
        hostA.target,
        hostA.ptyIdByLeafId[leafId]!,
        'A-after'
      )
    }
    expect(reportedPidByLeafId, "host A's panes are no longer talking to their own shells").toEqual(
      hostA.reportedPidByLeafId
    )
    console.log(
      `[journey3] host B partition ids: ${partitionIds.join(' ')}\n[journey3] host A after B's discovery: ${describeDockerSshRemoteShellIdentities(readDockerSshRemoteShellIdentities(hostA.target)).join(' ')} pids=${JSON.stringify(reportedPidByLeafId)}`
    )
  })
})
