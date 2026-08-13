/**
 * STA-3077 goalpost S3's affordance — an unreachable pane says so, offers two
 * actions, and destroys nothing.
 *
 * Before S3, `handlePtyReattachFailure` answered any reattach failure with a
 * synthetic `pty:exit { code: -1 }`, cleared provider state, deleted ownership
 * and expired the lease: four claims about a process nobody had observed, on a
 * shell that was usually still running. Collapsing that left the pane with no
 * signal at all, so the pane now renders as disconnected with exactly two
 * explicit actions — "Try again" and "Start a new terminal" — and its copy may
 * never assert the shell exited, because a failed attach is not result data.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HELD AS `fixme`: THE STATE IS NOT INDUCIBLE FROM THE HOST TODAY.
 *
 * The banner needs one narrow state — the SSH target reporting itself CONNECTED
 * while a single pane's `pty.attach` fails with an error that does not prove the
 * session gone. `TerminalPane` suppresses this banner entirely while
 * `showSshReconnectOverlay` is true, so any fault that takes the connection down
 * with it produces the connection-level overlay instead and never reaches here.
 *
 * Two host-side faults were driven against the real Docker relay and neither
 * lands in that state:
 *
 *  1. Stop the detached relay (SIGSTOP) and remount the pane. The relay keeps
 *     every shell, but the client reads the silent host as gone, reinstalls a
 *     relay beside it, and the SSH target drops to `connecting`. The pane's
 *     connect gate then DEFERS rather than attaching, so no attach fails at all;
 *     the pane shows "SSH connection required". Measured, not assumed: the run
 *     that produced this note timed out on the locator below with that overlay
 *     on screen. That fault is still worth having, and it is what
 *     ssh-reattach-does-not-resume-agent-twice.spec.ts uses to prove the
 *     non-destructive half of S3 — the shell stays alive, the lease stays
 *     claimable, and no second shell is launched.
 *  2. Sever the transport. Same shape: the target leaves `connected`, the gate
 *     defers, and the reattach that eventually runs succeeds.
 *
 * What would reach it is a fault that leaves the mux healthy and fails ONE pty:
 * the relay answering `sourceRecovery.restoreRequired` for a single id, which
 * today only arises from a delivery-record divergence between two client
 * generations. There is no seam to force that from a test without adding one in
 * `src/`, which this change is not allowed to do. The oracle is kept whole and
 * held rather than deleted, so it runs the day such a seam exists.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * MUTATIONS THAT MUST REDDEN THIS FILE ONCE IT RUNS:
 *  - `reattach-failure-classification.ts`: make `isProvenSshSessionGoneError`
 *    return true for every error. The pane respawns silently, so no banner
 *    appears and the census gains a second shell.
 *  - `TerminalPaneDisconnectedBanner.tsx`: reword the `ssh-pane` copy to say the
 *    terminal exited, or drop either action. Clause 2 or clause 1 reddens.
 *  - `ssh-relay-session.ts`: restore the destructive block in
 *    `handlePtyReattachFailure`. Clause 3 reddens on the expired lease.
 */
import type { Locator, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot,
  type PaneIdentitySnapshot
} from './helpers/terminal'
import {
  describeSshRemotePtyLeases,
  findSshRemotePtyLeaseForLeaf,
  readSshRemotePtyLeases,
  resolveOrcaProfileStateFile
} from './helpers/ssh-remote-pty-lease-file'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { readDockerSshRelayProcessSnapshot } from './helpers/docker-ssh-relay-processes'
import { resumeDockerSshRelay, stallDockerSshRelay } from './helpers/docker-ssh-relay-stall'
import {
  countDockerSshRelayRemoteStreamWriters,
  describeDockerSshRelayRemotePtys,
  readDockerSshRelayRemotePtys
} from './helpers/docker-ssh-relay-remote-ptys'
import {
  installRemotePaneLaunchTranscript,
  readRemotePaneLaunchPids
} from './helpers/remote-pane-launch-transcript'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const UNREACHABLE_PANE_INDUCTION_UNAVAILABLE =
  'No host-side fault leaves the SSH target connected while one pane attach fails; see the file header.'
// Why: the relay must outlive the fault. If it exits with the client the remote
// shells die too, and a dead shell makes "the banner overclaims" untestable.
const RELAY_GRACE_PERIOD_SECONDS = 900
// The banner is only reachable after the pane's `pty.attach` gives up, which
// costs one mux request timeout.
const UNREACHABLE_PANE_TIMEOUT_MS = 150_000

/**
 * The copy constraint as an oracle. A failed attach is not result data, so the
 * pane may not carry a result verb (STYLEGUIDE.md:236). Enforced here rather
 * than in review, because the tempting reword is exactly the old lie.
 */
const DEATH_VERB = /exit|died|dead|terminated|killed|crashed/i
/** The wire tokens the classification runs on must never reach the user. */
const WIRE_TOKEN = /SSH_[A-Z_]+/

test.use({ seedTestRepo: false })

type UnreachableRemotePane = {
  remote: Awaited<ReturnType<typeof connectDockerSshRelayTarget>>
  snapshot: PaneIdentitySnapshot
  paneKey: string
  leafId: string
  ptyId: string
  pid: number
  startTicks: number
  relayPid: number
  stateFile: string
  banner: Locator
}

/** Rebuild the pane's renderer over its live PTY — the app's own recovery seam. */
async function remountTerminalTabForRecovery(page: Page, tabId: string): Promise<void> {
  const remounted = await page.evaluate((tabId) => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    return state.remountTerminalTabForRecovery(tabId)
  }, tabId)
  expect(remounted, 'the terminal tab refused to remount, so no reattach was attempted').toBe(true)
}

/**
 * A connected remote workspace with one streaming pane whose host has stopped
 * answering. Why the pane must stream: an idle pane reattaches as 'existing' and
 * never enters the source re-establishment the field failure came through.
 */
async function openUnreachableRemotePane(
  page: Page,
  app: Parameters<typeof resolveOrcaProfileStateFile>[0],
  target: DockerSshRelayTarget
): Promise<UnreachableRemotePane> {
  installRemotePaneLaunchTranscript(target)

  await waitForSessionReady(page)
  const remote = await connectDockerSshRelayTarget(page, target, {
    relayGracePeriodSeconds: RELAY_GRACE_PERIOD_SECONDS
  })
  await expect.poll(() => waitForActiveWorktree(page), { timeout: 30_000 }).toBe(remote.worktreeId)
  await ensureTerminalVisible(page, 45_000)
  await waitForActiveTerminalManager(page, 60_000)
  await waitForActivePanePtyId(page, 60_000)

  const snapshot = await waitForPaneIdentitySnapshot(page, 1)
  const pane = snapshot.panes[0]
  if (!pane?.ptyId) {
    throw new Error('The remote workspace opened no pane with a PTY')
  }
  const paneKey = `${snapshot.tabId}:${pane.leafId}`

  const streamMarker = `SSH_AFFORDANCE_STREAM_${Date.now()}`
  await sendToTerminal(
    page,
    pane.ptyId,
    `node -e "setInterval(()=>process.stdout.write('${streamMarker}_'+Date.now()+'\\n'),100)" &\r`
  )
  await expect
    .poll(() => countDockerSshRelayRemoteStreamWriters(target, streamMarker), {
      timeout: 60_000,
      message: 'the remote pane never started streaming'
    })
    .toBe(1)

  // Anti-vacuity for every "no second shell" clause below: the host records one
  // launch for this pane now, so a later count of one means nothing was added.
  await expect
    .poll(() => readRemotePaneLaunchPids(target, paneKey).length, {
      timeout: 60_000,
      message: 'the host recorded no shell launch for the pane, so its transcript proves nothing'
    })
    .toBe(1)

  const shell = readDockerSshRelayRemotePtys(target).find((entry) => entry.paneKey === paneKey)
  if (!shell) {
    throw new Error(`The relay hosts no remote shell for pane ${paneKey}`)
  }
  const relay = readDockerSshRelayProcessSnapshot(target)
  if (!relay) {
    throw new Error('No detached relay to stall')
  }

  stallDockerSshRelay(target, relay.relayPid)
  await remountTerminalTabForRecovery(page, snapshot.tabId)

  return {
    remote,
    snapshot,
    paneKey,
    leafId: pane.leafId,
    ptyId: pane.ptyId,
    pid: shell.pid,
    startTicks: shell.startTicks,
    relayPid: relay.relayPid,
    stateFile: await resolveOrcaProfileStateFile(app),
    banner: page.locator('[data-terminal-pane-disconnected-variant="ssh-pane"]')
  }
}

test.describe('an unreachable SSH pane offers two actions and destroys nothing', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH faults use POSIX SSH tooling.')

  test('the pane reports itself disconnected without claiming the shell exited', async ({
    orcaPage,
    electronApp
  }, testInfo: TestInfo) => {
    test.fixme(true, UNREACHABLE_PANE_INDUCTION_UNAVAILABLE)
    test.setTimeout(600_000)
    let target: DockerSshRelayTarget | null = null
    let stalledRelayPid: number | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const relayTarget = target
      const unreachable = await openUnreachableRemotePane(orcaPage, electronApp, relayTarget)
      stalledRelayPid = unreachable.relayPid

      // 1. The pane says it is disconnected, in the SSH variant, with both actions.
      await expect(
        unreachable.banner,
        'the unreachable pane showed no disconnected affordance'
      ).toBeVisible({ timeout: UNREACHABLE_PANE_TIMEOUT_MS })
      await expect(
        unreachable.banner,
        'the disconnected pane is still advertising automatic retries'
      ).toHaveAttribute('data-terminal-remote-runtime-reconnect-banner', 'disconnected')
      await expect(unreachable.banner.getByRole('button', { name: 'Try again' })).toBeVisible()
      await expect(
        unreachable.banner.getByRole('button', { name: 'Start a new terminal' })
      ).toBeVisible()

      // 2. Copy constraint. Nothing here observed an exit, so nothing may report one.
      const copy = (await unreachable.banner.textContent()) ?? ''
      expect(copy.trim(), 'the disconnected banner rendered no copy at all').not.toBe('')
      expect(copy, 'the disconnected banner claims the shell is gone').not.toMatch(DEATH_VERB)
      expect(copy, 'the disconnected banner leaks a wire token').not.toMatch(WIRE_TOKEN)
      testInfo.annotations.push({ type: 'ssh-disconnected-pane-copy', description: copy })

      // 3. The claim under the copy: the shell is alive and the lease is not retired.
      const shellsWhileUnreachable = readDockerSshRelayRemotePtys(relayTarget)
      expect(
        shellsWhileUnreachable.filter(
          (shell) => shell.pid === unreachable.pid && shell.startTicks === unreachable.startTicks
        ),
        'the failed reattach killed the shell the pane owns'
      ).toHaveLength(1)
      const lease = findSshRemotePtyLeaseForLeaf(
        unreachable.stateFile,
        unreachable.remote.targetId,
        unreachable.leafId
      )
      expect(lease, 'the failed reattach dropped the pane lease').toBeDefined()
      expect(lease?.state, 'the failed reattach expired a lease over a running shell').not.toBe(
        'expired'
      )
      expect(lease?.state, 'the failed reattach retired a lease over a running shell').not.toBe(
        'terminated'
      )
      expect(
        readRemotePaneLaunchPids(relayTarget, unreachable.paneKey),
        'the failed reattach launched a second shell for the pane'
      ).toHaveLength(1)
      testInfo.annotations.push({
        type: 'ssh-disconnected-pane-unreachable',
        description: `${describeDockerSshRelayRemotePtys(shellsWhileUnreachable)} leases=${describeSshRemotePtyLeases(
          readSshRemotePtyLeases(unreachable.stateFile, unreachable.remote.targetId)
        )}`
      })

      // 4. 'Try again' reattaches the same shell once the host can answer again.
      resumeDockerSshRelay(relayTarget, unreachable.relayPid)
      stalledRelayPid = null
      await unreachable.banner.getByRole('button', { name: 'Try again' }).click()
      await expect(unreachable.banner, 'the banner outlived a successful retry').toBeHidden({
        timeout: UNREACHABLE_PANE_TIMEOUT_MS
      })
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const recovered = await waitForPaneIdentitySnapshot(orcaPage, 1)
      expect(recovered.panes[0]?.ptyId, 'the retry bound the pane to a different session').toBe(
        unreachable.ptyId
      )
      expect(
        readDockerSshRelayRemotePtys(relayTarget).map(
          (shell) => `${shell.paneKey ?? '-'}=${shell.pid}@${shell.startTicks}`
        ),
        'the retry added or replaced a remote shell'
      ).toEqual([`${unreachable.paneKey}=${unreachable.pid}@${unreachable.startTicks}`])
      expect(
        readRemotePaneLaunchPids(relayTarget, unreachable.paneKey),
        'the retry launched a second shell for the pane'
      ).toHaveLength(1)
    } finally {
      if (target && stalledRelayPid !== null) {
        resumeDockerSshRelay(target, stalledRelayPid)
      }
      cleanupDockerSshRelayTarget(target)
    }
  })

  // The other action, and the reason it is not styled as a loss: it adds a shell
  // rather than replacing one, and the pane the user had is still the pane the
  // user has.
  test('starting a new terminal adds exactly one shell and leaves the panes alone', async ({
    orcaPage,
    electronApp
  }, testInfo: TestInfo) => {
    test.fixme(true, UNREACHABLE_PANE_INDUCTION_UNAVAILABLE)
    test.setTimeout(600_000)
    let target: DockerSshRelayTarget | null = null
    let stalledRelayPid: number | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const relayTarget = target
      const unreachable = await openUnreachableRemotePane(orcaPage, electronApp, relayTarget)
      stalledRelayPid = unreachable.relayPid

      await expect(
        unreachable.banner,
        'the unreachable pane showed no disconnected affordance'
      ).toBeVisible({ timeout: UNREACHABLE_PANE_TIMEOUT_MS })

      resumeDockerSshRelay(relayTarget, unreachable.relayPid)
      stalledRelayPid = null
      await unreachable.banner.getByRole('button', { name: 'Start a new terminal' }).click()

      // Exactly one more shell: the one the user asked for. The old shell is left
      // running, which is what makes "starting a new one leaves it alone" true.
      await expect
        .poll(() => readRemotePaneLaunchPids(relayTarget, unreachable.paneKey).length, {
          timeout: UNREACHABLE_PANE_TIMEOUT_MS,
          message: 'starting a new terminal did not settle at exactly one additional launch'
        })
        .toBe(2)
      expect(
        readDockerSshRelayRemotePtys(relayTarget).filter(
          (shell) => shell.pid === unreachable.pid && shell.startTicks === unreachable.startTicks
        ),
        'starting a new terminal killed the shell it promised to leave alone'
      ).toHaveLength(1)
      expect(
        readDockerSshRelayRemotePtys(relayTarget),
        'starting a new terminal changed the host by more than one shell'
      ).toHaveLength(2)

      // The pane count is a user-visible promise: a new shell is not a new pane.
      const paneCount = await orcaPage.evaluate((worktreeId) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Store unavailable')
        }
        type LayoutNode =
          | { type: 'leaf'; leafId: string }
          | { type: 'split'; first: LayoutNode; second: LayoutNode }
          | null
        const collectLeafIds = (node: LayoutNode): string[] =>
          !node
            ? []
            : node.type === 'leaf'
              ? [node.leafId]
              : [...collectLeafIds(node.first), ...collectLeafIds(node.second)]
        return (state.tabsByWorktree[worktreeId] ?? []).reduce((total, tab) => {
          const leaves = collectLeafIds(
            (state.terminalLayoutsByTabId[tab.id]?.root ?? null) as LayoutNode
          )
          return total + Math.max(leaves.length, 1)
        }, 0)
      }, unreachable.remote.worktreeId)
      expect(paneCount, 'starting a new terminal surfaced a pane the user never opened').toBe(1)
      testInfo.annotations.push({
        type: 'ssh-disconnected-pane-new-terminal',
        description: describeDockerSshRelayRemotePtys(readDockerSshRelayRemotePtys(relayTarget))
      })
    } finally {
      if (target && stalledRelayPid !== null) {
        resumeDockerSshRelay(target, stalledRelayPid)
      }
      cleanupDockerSshRelayTarget(target)
    }
  })
})
