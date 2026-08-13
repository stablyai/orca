/**
 * STA-3077 goalpost S3 — a reattach failure may not become a respawn — and S8,
 * which removed the last path that granted one without being asked.
 *
 * The reported failure: a coding agent was resumed twice into one transcript.
 * The mechanism is a converging decision. A reattach that failed for any reason
 * was read as proof the session had gone, so `handlePtyReattachFailure` sent the
 * pane a synthetic `pty:exit { code: -1 }`, the pane read that as a death, and
 * the cold-restore resume ran with the same provider session id over a shell
 * that was still running. Two agent processes then appended to one transcript.
 * Respawn now requires proof; everything else stays unresolved.
 *
 * WHAT IS PROXIED, AND WHY. A real coding agent cannot be driven here: the
 * Docker OpenSSH fixture ships no agent binary and there is no provider session
 * to resume, so "one transcript, two resumes" has no literal form in this
 * harness. The observable moves one level down, to the thing that must happen
 * before an agent can be resumed twice — a SECOND shell launching for a pane
 * that already has one. The host records every launch itself
 * (helpers/remote-pane-launch-transcript.ts), so the count is taken on the
 * container and owes the app nothing.
 *
 * THE FAULT. The detached relay is stopped, not killed. It keeps every shell it
 * hosts (SIGSTOP suspends one process, not its children) and answers nothing.
 * The client treats the silent host as gone and reinstalls a relay beside it, so
 * the pane's session is one the new relay has never heard of, over a shell that
 * is provably still running on the container — which is exactly the state the
 * fabricated exit used to lie about.
 *
 * MUTATIONS THAT MUST REDDEN THIS FILE:
 *  - `src/main/ssh/ssh-relay-session.ts`: restore the destructive block in
 *    `handlePtyReattachFailure`. The fabricated exit reaches the pane, which
 *    cold-restores over a live shell and the host records a second launch.
 *  - `src/renderer/.../reattach-failure-classification.ts`: make
 *    `isProvenSshSessionGoneError` return true for every error, and the pane's
 *    own reattach arm respawns instead of holding.
 *  - `src/main/runtime/orca-runtime.ts`: reinstate the recovery grant S8 deleted
 *    from `recoverTerminalPane`, with its id comparison normalized so it can
 *    actually fire; a disconnected pane then starts a replacement on its own.
 */
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import {
  findSshRemotePtyLeaseForLeaf,
  describeSshRemotePtyLeases,
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
// Why: the relay must outlive the fault. If it exits with the client the remote
// shells die too, and a respawn over a corpse is not the defect this bounds.
const RELAY_GRACE_PERIOD_SECONDS = 900
// The pane has to give up on a host that answers nothing, which costs a mux
// request timeout before anything is classified.
const UNREACHABLE_PANE_TIMEOUT_MS = 180_000
// A respawn can land late, after the failure is classified. One sample would
// miss it, so every clause is held over a window instead.
const HOLD_WINDOW_MS = 25_000

test.use({ seedTestRepo: false })

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

test.describe('a failed SSH reattach never starts a second shell for the pane', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Docker SSH faults use POSIX SSH tooling.')

  test('a host that stops answering leaves the pane on the shell it already had', async ({
    orcaPage,
    electronApp
  }, testInfo: TestInfo) => {
    test.setTimeout(600_000)
    let target: DockerSshRelayTarget | null = null
    let stalledRelayPid: number | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const relayTarget = target
      installRemotePaneLaunchTranscript(relayTarget)

      await waitForSessionReady(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, relayTarget, {
        relayGracePeriodSeconds: RELAY_GRACE_PERIOD_SECONDS
      })
      await expect
        .poll(() => waitForActiveWorktree(orcaPage), { timeout: 30_000 })
        .toBe(remote.worktreeId)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 1)
      const pane = snapshot.panes[0]
      if (!pane?.ptyId) {
        throw new Error('The remote workspace opened no pane with a PTY')
      }
      const paneKey = `${snapshot.tabId}:${pane.leafId}`
      const stateFile = await resolveOrcaProfileStateFile(electronApp)

      // Why the pane must stream: an idle pane reattaches as 'existing' and never
      // enters the source re-establishment the field failure came through.
      const streamMarker = `SSH_RESUME_ONCE_STREAM_${Date.now()}`
      await sendToTerminal(
        orcaPage,
        pane.ptyId,
        `node -e "setInterval(()=>process.stdout.write('${streamMarker}_'+Date.now()+'\\n'),100)" &\r`
      )
      await expect
        .poll(() => countDockerSshRelayRemoteStreamWriters(relayTarget, streamMarker), {
          timeout: 60_000,
          message: 'the remote pane never started streaming'
        })
        .toBe(1)

      // Anti-vacuity. Every clause below counts launches; had the host recorded
      // none, "still exactly one" would prove nothing at all.
      await expect
        .poll(() => readRemotePaneLaunchPids(relayTarget, paneKey).length, {
          timeout: 60_000,
          message: 'the host recorded no shell launch for the pane, so its transcript is inert'
        })
        .toBe(1)
      const launchPid = readRemotePaneLaunchPids(relayTarget, paneKey)[0]
      const shell = readDockerSshRelayRemotePtys(relayTarget).find(
        (entry) => entry.paneKey === paneKey
      )
      if (!shell) {
        throw new Error(`The relay hosts no remote shell for pane ${paneKey}`)
      }
      // Cross-checks the transcript against the process census: the pid the host
      // logged at launch is the pid the relay hosts for this pane.
      expect(
        shell.pid,
        'the launch the host recorded is not the shell the relay hosts for this pane'
      ).toBe(launchPid)
      const shellIdentity = `${shell.pid}@${shell.startTicks}`
      testInfo.annotations.push({
        type: 'ssh-resume-once-baseline',
        description: `${describeDockerSshRelayRemotePtys(readDockerSshRelayRemotePtys(relayTarget))} launches=1`
      })

      const relay = readDockerSshRelayProcessSnapshot(relayTarget)
      if (!relay) {
        throw new Error('No detached relay to stall')
      }
      stallDockerSshRelay(relayTarget, relay.relayPid)
      stalledRelayPid = relay.relayPid
      await remountTerminalTabForRecovery(orcaPage, snapshot.tabId)

      // Vacuity guard: the pane has to actually lose its host before "it kept its
      // shell" means anything. This overlay is the user-visible proof it did —
      // without it, a pane that quietly reattached would pass every clause below.
      await expect(
        orcaPage.locator('[data-terminal-ssh-reconnect-banner]').first(),
        'the pane never lost its host, so the clauses below are vacuous'
      ).toBeVisible({ timeout: UNREACHABLE_PANE_TIMEOUT_MS })

      /** Everything a duplicate resume would move, read from the host and from disk. */
      const expectNoSecondShell = (label: string): void => {
        expect(
          readRemotePaneLaunchPids(relayTarget, paneKey),
          `${label} launched a second shell for pane ${paneKey}`
        ).toEqual([launchPid])
        expect(
          readDockerSshRelayRemotePtys(relayTarget)
            .filter((entry) => entry.paneKey === paneKey)
            .map((entry) => `${entry.pid}@${entry.startTicks}`),
          `${label} killed or replaced the shell the pane owns`
        ).toEqual([shellIdentity])
        // Unknown is not dead: the lease must stay claimable so a later reattach
        // can still find this shell.
        const lease = findSshRemotePtyLeaseForLeaf(stateFile, remote.targetId, pane.leafId)
        expect(lease, `${label} dropped the pane lease`).toBeDefined()
        expect(lease?.state, `${label} expired a lease over a running shell`).not.toBe('expired')
        expect(lease?.state, `${label} retired a lease over a running shell`).not.toBe('terminated')
      }

      // Sample continuously rather than poll-until-equal: a respawn that lands
      // and is later tidied up would satisfy a poll needing one matching read.
      const deadline = Date.now() + HOLD_WINDOW_MS
      let samples = 0
      while (Date.now() < deadline) {
        expectNoSecondShell('the unreachable host')
        samples += 1
        await orcaPage.waitForTimeout(500)
      }
      expect(samples).toBeGreaterThan(10)

      // The host comes back and nothing is granted automatically: a disconnected
      // pane refuses to respawn on its own (S8), so the only route to a second
      // shell is the user asking for one.
      resumeDockerSshRelay(relayTarget, relay.relayPid)
      stalledRelayPid = null
      await orcaPage.waitForTimeout(HOLD_WINDOW_MS)
      expectNoSecondShell('the host returning')
      testInfo.annotations.push({
        type: 'ssh-resume-once-settled',
        description: `${describeDockerSshRelayRemotePtys(
          readDockerSshRelayRemotePtys(relayTarget)
        )} launches=${readRemotePaneLaunchPids(relayTarget, paneKey).length} leases=${describeSshRemotePtyLeases(
          readSshRemotePtyLeases(stateFile, remote.targetId)
        )}`
      })
    } finally {
      if (target && stalledRelayPid !== null) {
        resumeDockerSshRelay(target, stalledRelayPid)
      }
      cleanupDockerSshRelayTarget(target)
    }
  })
})
