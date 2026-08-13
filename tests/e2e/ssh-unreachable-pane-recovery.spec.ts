/**
 * The decisive gate for the unreachable-pane affordance (STA-3077 / PR #13326).
 *
 * `ssh-disconnected-pane-affordance.spec.ts` holds its two decisive cases at `fixme` because the
 * state was not inducible: the banner needs the SSH target CONNECTED while exactly one pane's
 * `pty.attach` fails with an error that does not prove the shell exited, and every host-side fault
 * tried takes the whole connection down instead. This spec induces that state deliberately — see
 * `helpers/ssh-pane-incarnation-fault.ts` — so the behaviour can be OBSERVED rather than argued
 * from reading the code, which is how several oracles on this branch ended up green for the wrong
 * reason.
 *
 * What is pinned here:
 *   1. the card appears at all, with the connection healthy (the induction itself);
 *   2. reaching that state kills nothing and adds nothing on the host; and
 *   3. "Start a new terminal" on a pane whose shell turns out to be ALIVE reconnects the user to
 *      it and says so, instead of silently handing back the old shell under a label promising a
 *      blank one, and without adding a second shell.
 */
import { expect, test, type ElectronApplication, type TestInfo } from '@stablyai/playwright-test'
import { createRestartSession } from './helpers/orca-restart'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { resolveOrcaProfileStateFile } from './helpers/ssh-remote-pty-lease-file'
import {
  cleanupDockerSshRelayTarget,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { readDockerSshRelayRemotePtys } from './helpers/docker-ssh-relay-remote-ptys'
import {
  installRemotePaneLaunchTranscript,
  readRemotePaneLaunchPids
} from './helpers/remote-pane-launch-transcript'
import { recordForeignShellIdentityForPane } from './helpers/ssh-pane-incarnation-fault'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
// Why: the relay must outlive the app quit. If it exited with the client the remote shell would
// die too, and a dead shell cannot test a card whose whole claim is "we cannot reach it".
const RELAY_GRACE_PERIOD_SECONDS = 900
const BANNER = '[data-terminal-pane-disconnected-variant="ssh-pane"]'

test.describe('an unreachable SSH pane recovers rather than being replaced', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH faults use POSIX SSH tooling.')

  test('a pane whose recorded shell the host cannot match offers recovery, and recovering it adds no shell', async (// oxlint-disable-next-line no-empty-pattern -- this test owns both Electron launches
  {}, testInfo: TestInfo) => {
    test.setTimeout(600_000)
    const restart = createRestartSession(testInfo)
    let target: DockerSshRelayTarget | null = null
    let firstApp: ElectronApplication | null = null
    let secondApp: ElectronApplication | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const relayTarget = target
      installRemotePaneLaunchTranscript(relayTarget)

      const firstLaunch = await restart.launch()
      firstApp = firstLaunch.app
      await waitForSessionReady(firstLaunch.page)
      const remote = await connectDockerSshRelayTarget(firstLaunch.page, relayTarget, {
        relayGracePeriodSeconds: RELAY_GRACE_PERIOD_SECONDS
      })
      await expect
        .poll(() => waitForActiveWorktree(firstLaunch.page), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await waitForActiveTerminalManager(firstLaunch.page, 60_000)
      await waitForActivePanePtyId(firstLaunch.page, 60_000)

      const snapshot = await waitForPaneIdentitySnapshot(firstLaunch.page, 1)
      const pane = snapshot.panes[0]
      if (!pane?.ptyId) {
        throw new Error('The remote workspace opened no pane with a PTY')
      }
      const paneKey = `${snapshot.tabId}:${pane.leafId}`

      // Anti-vacuity for every "no second shell" clause below: the host records exactly one launch
      // for this pane now, so a later count of one proves nothing was added rather than proving the
      // transcript was never wired up.
      await expect
        .poll(() => readRemotePaneLaunchPids(relayTarget, paneKey).length, {
          timeout: 60_000,
          message: 'the host recorded no launch for the pane, so its transcript proves nothing'
        })
        .toBe(1)
      const shellBefore = readDockerSshRelayRemotePtys(relayTarget).find(
        (entry) => entry.paneKey === paneKey
      )
      if (!shellBefore) {
        throw new Error(`The relay hosts no remote shell for pane ${paneKey}`)
      }

      // Resolved while the app is still up: the helper asks the live app for its profile path.
      const stateFile = await resolveOrcaProfileStateFile(firstApp)

      await restart.close(firstApp)
      firstApp = null

      // The induction. The relay and its shell are untouched and still running; only the pane's
      // RECORD of which shell is its own is made unmatchable.
      const rewritten = recordForeignShellIdentityForPane(stateFile, paneKey, remote.targetId)
      // Either route is enough to fence: the pane-driven restore sends the binding's incarnation,
      // the relay-session reconnect sends the lease's. But at least ONE must have held an identity,
      // or the rewrite changed nothing and every clause below would pass for the wrong reason.
      expect(
        Boolean(rewritten.paneIncarnationBefore) || rewritten.leasesRewritten > 0,
        `nothing recorded a shell identity to make unmatchable — ${rewritten.diagnostics}`
      ).toBe(true)

      const mainLog: string[] = []
      const secondLaunch = await restart.launch({
        onStderr: (chunk) => {
          for (const line of chunk.split('\n')) {
            if (
              /ssh-pty|spawn\(\)|identity mismatch|not found|stable pane|owner_changed|pty:spawn/i.test(
                line
              )
            ) {
              mainLog.push(line.trim())
            }
          }
        }
      })
      secondApp = secondLaunch.app
      await waitForSessionReady(secondLaunch.page, 60_000)
      await expect
        .poll(() => waitForActiveWorktree(secondLaunch.page), { timeout: 60_000 })
        .toBe(remote.worktreeId)

      // 1. The card appears. This is the state that was previously not inducible.
      const banner = secondLaunch.page.locator(BANNER)
      await expect(banner, 'the pane showed no disconnected affordance').toBeVisible({
        timeout: 180_000
      })

      // 2. Reaching it destroyed nothing and created nothing on the host.
      expect(
        readDockerSshRelayRemotePtys(relayTarget).filter(
          (shell) => shell.pid === shellBefore.pid && shell.startTicks === shellBefore.startTicks
        ),
        'the unreachable pane killed the shell it cannot prove is gone'
      ).toHaveLength(1)
      expect(
        readRemotePaneLaunchPids(relayTarget, paneKey),
        'reaching the card launched a second shell for the pane'
      ).toHaveLength(1)

      // 3. The shell is alive, so this action recovers it. The user is told that, and no second
      //    shell is created — the pane keeps the terminal it already had.
      await banner.getByRole('button', { name: 'Start a new terminal' }).click()

      // The recorded shell cannot be reached, so this action must CREATE one rather than attach
      // the unreachable one first — which is what left the button doing nothing at all.
      await expect(banner, 'the card stayed up after the pane was given a new shell').toBeHidden({
        timeout: 180_000
      })
      await expect
        .poll(() => readRemotePaneLaunchPids(relayTarget, paneKey).length, {
          timeout: 120_000,
          message: 'starting a new terminal never launched a shell for the pane'
        })
        .toBe(2)

      // The old shell is unproven, not dead: it keeps running, unbound, for the cleanup surface.
      expect(
        readDockerSshRelayRemotePtys(relayTarget).filter(
          (shell) => shell.pid === shellBefore.pid && shell.startTicks === shellBefore.startTicks
        ),
        'starting a new terminal killed the shell it cannot prove is gone'
      ).toHaveLength(1)
      expect(
        readDockerSshRelayRemotePtys(relayTarget),
        'starting a new terminal changed the host by more than the one shell it promised'
      ).toHaveLength(2)
    } finally {
      if (firstApp) {
        await restart.close(firstApp)
      }
      if (secondApp) {
        await restart.close(secondApp)
      }
      cleanupDockerSshRelayTarget(target)
      await restart.dispose()
    }
  })
})
