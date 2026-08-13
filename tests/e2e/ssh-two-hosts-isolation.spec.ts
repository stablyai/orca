/**
 * Journey 7 — two independent Docker SSH hosts, live at the same time, in one
 * app.
 *
 * Two real OpenSSH containers, two SSH targets, two remote repos, and two panes
 * each — one streaming, one at a prompt. The spec asserts the boundary in both
 * directions: nothing host A owns appears under host B, and severing host A's
 * transport leaves host B's connection, panes, durable bindings, remote shells,
 * and — the part a state census cannot see — host B's ability to run a command
 * completely untouched.
 *
 * Host A's shells are counted too, on host A's own container: a severed
 * transport is not proof that anything died, so they must still be there when
 * it comes back.
 *
 * What this spec does NOT discriminate against, and why: the blast radius of a
 * PTY-level delivery failure. Severing a transport is the only fault reachable
 * from outside the app, and it cannot produce a rejected delivery frame whose
 * recovery budget then runs out — that needs a relay publishing a source header
 * this client never installed. `src/main/ssh/ssh-relay-session-two-host-delivery-isolation.integration.test.ts`
 * injects exactly that on the relay wire and owns that half of Journey 4.
 */
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import {
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
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { severDockerSshRelayTransport } from './helpers/docker-ssh-relay-processes'
import {
  countDockerSshRelayRemoteStreamWriters,
  describeDockerSshRelayRemotePtys,
  readDockerSshRelayRemotePtys
} from './helpers/docker-ssh-relay-remote-ptys'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const PANE_COUNT = 2
// Why: the relay must outlive the fault. If it exits with the client the remote
// shells die too and the fault stops being a containment question.
const RELAY_GRACE_PERIOD_SECONDS = 900
// Why: contamination lands after the fault handler returns, so every dimension
// is re-read across a window rather than sampled once.
const CONTAINMENT_WINDOW_MS = 20_000
const CONTAINMENT_SAMPLE_MS = 1_000

test.use({ seedTestRepo: false })

type RemoteHost = {
  label: 'A' | 'B'
  target: DockerSshRelayTarget
  remote: Awaited<ReturnType<typeof connectDockerSshRelayTarget>>
  hostId: string
  tabId: string
  ptyIds: string[]
  /** Pane 0 runs the endless writer; pane 1 stays a usable shell. */
  commandPtyId: string
  streamMarker: string
  remotePids: number[]
}

function ptyIdBelongsToTarget(ptyId: string, targetId: string): boolean {
  return ptyId.startsWith(`ssh:${encodeURIComponent(targetId)}@@`)
}

async function readSshStatus(page: Page, targetId: string): Promise<string | null> {
  return page.evaluate(
    async (targetId) => (await window.api.ssh.getState({ targetId }))?.status ?? null,
    targetId
  )
}

/** Connects one container and opens PANE_COUNT panes on it, one of them streaming. */
async function openRemoteHost(
  page: Page,
  label: 'A' | 'B',
  target: DockerSshRelayTarget
): Promise<RemoteHost> {
  const remote = await connectDockerSshRelayTarget(page, target, {
    relayGracePeriodSeconds: RELAY_GRACE_PERIOD_SECONDS
  })
  await expect.poll(() => waitForActiveWorktree(page), { timeout: 30_000 }).toBe(remote.worktreeId)
  await ensureTerminalVisible(page, 45_000)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)
  await splitActiveTerminalPane(page, 'vertical')
  const snapshot = await waitForPaneIdentitySnapshot(page, PANE_COUNT)

  const ptyIds = snapshot.panes.map((pane) => {
    if (!pane.ptyId) {
      throw new Error(`Host ${label} pane ${pane.leafId} has no PTY`)
    }
    return pane.ptyId
  })

  // Why one streaming pane: an idle host carries no output source, so a fault
  // never reaches the delivery machinery whose blast radius this journey
  // bounds. The sibling pane is left at a prompt so the host stays usable.
  const streamMarker = `TWO_HOST_${label}_${Date.now()}`
  await sendToTerminal(
    page,
    ptyIds[0]!,
    `node -e "setInterval(()=>process.stdout.write('${streamMarker}_'+Date.now()+'\\n'),25)"\r`
  )
  await expect
    .poll(() => countDockerSshRelayRemoteStreamWriters(target, streamMarker), {
      timeout: 60_000,
      message: `host ${label} pane did not start streaming`
    })
    .toBe(1)
  await expect
    .poll(() => readDockerSshRelayRemotePtys(target).length, {
      timeout: 60_000,
      message: `host ${label} did not settle at one remote shell per pane`
    })
    .toBe(PANE_COUNT)

  return {
    label,
    target,
    remote,
    hostId: sshExecutionHostId(remote.targetId),
    tabId: snapshot.tabId,
    ptyIds,
    commandPtyId: ptyIds[1]!,
    streamMarker,
    remotePids: readDockerSshRelayRemotePtys(target).map((pty) => pty.pid)
  }
}

/**
 * Runs a command through the host's own pane and proves it executed on that
 * host's container — the one dimension no amount of persisted state can fake.
 */
async function proveHostRunsCommands(page: Page, host: RemoteHost, phase: string): Promise<string> {
  const stamp = `/tmp/orca-two-host-${host.label}-${phase}-${Date.now()}`
  await expect
    .poll(
      async () => {
        // Why resend on every probe: a shell that is mid-prompt, parked, or
        // reattaching can swallow the first line, and one lost keystroke would
        // read as a dead host.
        await sendToTerminal(page, host.commandPtyId, `touch ${stamp}\r`)
        return execDockerSshRelayTargetCommand(
          host.target,
          `test -e ${shellQuote(stamp)} && printf yes || printf no`
        )
      },
      {
        timeout: 60_000,
        intervals: [1_000],
        message: `host ${host.label} could not run a command through its own pane (${phase})`
      }
    )
    .toBe('yes')
  return stamp
}

function assertStampIsLocalToHost(stamp: string, elsewhere: DockerSshRelayTarget): void {
  expect(
    execDockerSshRelayTargetCommand(
      elsewhere,
      `test -e ${shellQuote(stamp)} && printf yes || printf no`
    ),
    `a command run on one host reached the other container (${stamp})`
  ).toBe('no')
}

test.describe('Two independent Docker SSH hosts', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH uses POSIX SSH tooling.')

  test('keep sessions disjoint and contain one host transport failure', async ({
    orcaPage
  }, testInfo: TestInfo) => {
    test.setTimeout(900_000)
    let targetA: DockerSshRelayTarget | null = null
    let targetB: DockerSshRelayTarget | null = null
    try {
      targetA = startDockerSshRelayTarget(testInfo)
      targetB = startDockerSshRelayTarget(testInfo)
      await waitForSessionReady(orcaPage)

      const hostA = await openRemoteHost(orcaPage, 'A', targetA)
      const hostB = await openRemoteHost(orcaPage, 'B', targetB)
      const containerA = targetA
      const containerB = targetB

      // --- both hosts live at once, and nothing is shared -------------------
      expect(await readSshStatus(orcaPage, hostA.remote.targetId)).toBe('connected')
      expect(await readSshStatus(orcaPage, hostB.remote.targetId)).toBe('connected')
      expect(hostA.remote.targetId).not.toBe(hostB.remote.targetId)
      expect(hostA.remote.repoId).not.toBe(hostB.remote.repoId)
      expect(hostA.remote.worktreeId).not.toBe(hostB.remote.worktreeId)
      expect(hostA.tabId).not.toBe(hostB.tabId)
      expect(hostA.ptyIds.filter((id) => hostB.ptyIds.includes(id))).toEqual([])
      for (const host of [hostA, hostB]) {
        for (const ptyId of host.ptyIds) {
          expect(
            ptyIdBelongsToTarget(ptyId, host.remote.targetId),
            `host ${host.label} pane PTY ${ptyId} is not scoped to its own target`
          ).toBe(true)
        }
      }

      // Remote shells: each container hosts exactly its own panes and nothing
      // stamped with the other host's workspace.
      for (const [host, other] of [
        [hostA, hostB],
        [hostB, hostA]
      ] as const) {
        const ptys = readDockerSshRelayRemotePtys(host.target)
        expect(ptys, `host ${host.label} shell count`).toHaveLength(PANE_COUNT)
        for (const pty of ptys) {
          expect(pty.worktreeId, `host ${host.label} shell ${pty.pid} worktree`).toBe(
            host.remote.worktreeId
          )
          expect(pty.tabId, `host ${host.label} shell ${pty.pid} tab`).toBe(host.tabId)
          expect(pty.worktreeId).not.toBe(other.remote.worktreeId)
        }
        expect(
          countDockerSshRelayRemoteStreamWriters(host.target, other.streamMarker),
          `host ${other.label}'s output writers appeared on host ${host.label}'s container`
        ).toBe(0)
      }

      // Durable state: no id minted by one host is named under the other.
      const bindingsA = await readDurablePaneBindings(
        orcaPage,
        hostA.hostId,
        hostA.remote.worktreeId
      )
      const bindingsB = await readDurablePaneBindings(
        orcaPage,
        hostB.hostId,
        hostB.remote.worktreeId
      )
      expect(bindingsA).not.toHaveLength(0)
      expect(bindingsB).not.toHaveLength(0)
      const assertPartitionsAreDisjoint = async (): Promise<void> => {
        for (const [host, other] of [
          [hostA, hostB],
          [hostB, hostA]
        ] as const) {
          const ids = await readDurablePartitionPtyIds(orcaPage, host.hostId)
          expect(
            ids.filter((id) => ptyIdBelongsToTarget(id, other.remote.targetId)),
            `host ${other.label}'s PTY ids appeared in host ${host.label}'s durable partition`
          ).toEqual([])
        }
      }
      await assertPartitionsAreDisjoint()

      const stampA = await proveHostRunsCommands(orcaPage, hostA, 'baseline')
      const stampB = await proveHostRunsCommands(orcaPage, hostB, 'baseline')
      assertStampIsLocalToHost(stampA, containerB)
      assertStampIsLocalToHost(stampB, containerA)
      testInfo.annotations.push({
        type: 'two-host-baseline',
        description: `A=[${describeDockerSshRelayRemotePtys(readDockerSshRelayRemotePtys(containerA))}] B=[${describeDockerSshRelayRemotePtys(readDockerSshRelayRemotePtys(containerB))}]`
      })

      // --- sever host A, then hold host B to every baseline ----------------
      severDockerSshRelayTransport(containerA)
      // Why switch: reattach only runs for a revealed workspace, so host A has
      // to be the one on screen while host B rides out the fault in the
      // background — the arrangement in which a leak is easiest to miss.
      await switchToWorktree(orcaPage, hostA.remote.worktreeId)

      const deadline = Date.now() + CONTAINMENT_WINDOW_MS
      let samples = 0
      while (Date.now() < deadline) {
        expect(
          await readSshStatus(orcaPage, hostB.remote.targetId),
          'host B left connected while host A was severed'
        ).toBe('connected')
        expect(
          readDockerSshRelayRemotePtys(containerB).map((pty) => pty.pid),
          'host B lost or gained a remote shell while host A was severed'
        ).toEqual(hostB.remotePids)
        expect(
          await readDurablePaneBindings(orcaPage, hostB.hostId, hostB.remote.worktreeId),
          'host B durable pane bindings changed while host A was severed'
        ).toEqual(bindingsB)
        // Unknown is not dead: host A's shells outlive its transport.
        expect(
          readDockerSshRelayRemotePtys(containerA).map((pty) => pty.pid),
          'host A shells were destroyed by its own transport fault'
        ).toEqual(hostA.remotePids)
        await assertPartitionsAreDisjoint()
        samples += 1
        await orcaPage.waitForTimeout(CONTAINMENT_SAMPLE_MS)
      }
      expect(samples).toBeGreaterThan(4)

      // The dimension no census covers: host B must still be able to work.
      const stampBDuringFault = await proveHostRunsCommands(orcaPage, hostB, 'during-fault')
      assertStampIsLocalToHost(stampBDuringFault, containerA)
      expect(
        countDockerSshRelayRemoteStreamWriters(containerB, hostB.streamMarker),
        'host B stopped streaming while host A was severed'
      ).toBe(1)

      // --- host A recovers without disturbing host B ------------------------
      await expect
        .poll(() => readSshStatus(orcaPage, hostA.remote.targetId), {
          timeout: 180_000,
          message: 'host A did not reconnect after its transport was severed'
        })
        .toBe('connected')
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      expect(
        readDockerSshRelayRemotePtys(containerA).map((pty) => pty.pid),
        'host A reconnect changed its own remote shells'
      ).toEqual(hostA.remotePids)
      expect(
        readDockerSshRelayRemotePtys(containerB).map((pty) => pty.pid),
        'host A reconnect changed host B remote shells'
      ).toEqual(hostB.remotePids)
      expect(
        await readDurablePaneBindings(orcaPage, hostB.hostId, hostB.remote.worktreeId),
        'host A reconnect changed host B durable pane bindings'
      ).toEqual(bindingsB)
      await assertPartitionsAreDisjoint()

      const stampAAfter = await proveHostRunsCommands(orcaPage, hostA, 'after-recovery')
      const stampBAfter = await proveHostRunsCommands(orcaPage, hostB, 'after-recovery')
      assertStampIsLocalToHost(stampAAfter, containerB)
      assertStampIsLocalToHost(stampBAfter, containerA)
      testInfo.annotations.push({
        type: 'two-host-final',
        description: `A=[${describeDockerSshRelayRemotePtys(readDockerSshRelayRemotePtys(containerA))}] B=[${describeDockerSshRelayRemotePtys(readDockerSshRelayRemotePtys(containerB))}]`
      })
    } finally {
      cleanupDockerSshRelayTarget(targetA)
      cleanupDockerSshRelayTarget(targetB)
    }
  })
})
