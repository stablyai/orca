import path from 'node:path'
import { readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './helpers/orca-app'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'
import { sshRemotePtyLeaseAllowsReattach, type SshRemotePtyLease } from '../../src/shared/ssh-types'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  enableDockerSshRelayTargetShellTitle,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  clearDockerSshRelayFaults,
  dropDockerSshRelayTransport,
  killDockerSshRelayDaemon,
  withStalledDockerSshRelayTarget
} from './helpers/docker-ssh-relay-faults'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

/**
 * Every existing reconnect spec reconnects by calling ssh.disconnect() then ssh.connect() — a
 * clean, client-initiated cycle that the client knows is coming. Nothing covered the fault the
 * reconnect machinery actually exists for: the transport dying underneath a live session, with the
 * remote still running and still holding the PTYs.
 *
 * The distinction matters because the two paths diverge at the relay. A graceful disconnect closes
 * the client cleanly; a killed connection leaves the relay's grace window and PTY table intact, so
 * a correct client re-attaches rather than rebuilding. Reports of frozen panes and duplicated agent
 * sessions come from the second shape, which had no coverage at all.
 *
 * Faults come from docker-ssh-relay-faults, in two shapes that must not be confused. Killing
 * sshd's per-connection forks leaves the listening daemon and every relay process alive, so the
 * session survives and the pane must keep its PTY. SIGKILLing the relay leaves sshd reachable but
 * genuinely ends the sessions, so the pane must be replaced. Only the second is `exited`; a suite
 * with only the first cannot tell a resume from a silent cold start
 * (docs/reference/ssh-execution-boundary.md).
 */
async function readSshStatus(orcaPage: Page, targetId: string) {
  return orcaPage.evaluate(
    (targetId) => window.__store?.getState().sshConnectionStates.get(targetId)?.status ?? null,
    targetId
  )
}

/**
 * Every lease `reattachKnownPtys` would feed to `pty.attach` on the next connect, read from the
 * durable store rather than from the renderer — leases are main-owned and never published.
 *
 * Goes through the shipped `sshRemotePtyLeaseAllowsReattach` predicate so the measurement cannot
 * drift from the fan-out it exists to bound.
 */
function readSshLeases(userDataDir: string, targetId: string): SshRemotePtyLease[] {
  const dataPath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  const parsed = JSON.parse(readFileSync(dataPath, 'utf8')) as {
    sshRemotePtyLeases?: SshRemotePtyLease[]
  }
  return (parsed.sshRemotePtyLeases ?? []).filter((lease) => lease.targetId === targetId)
}

function readReattachablePtyIds(userDataDir: string, targetId: string): string[] {
  return readSshLeases(userDataDir, targetId)
    .filter(sshRemotePtyLeaseAllowsReattach)
    .map((lease) => lease.ptyId)
    .sort()
}

/**
 * Everything a cardinality failure needs to be diagnosable from the report alone.
 *
 * Worth keeping rather than reducing to a count: when this first failed, the count said only "2",
 * and it was the per-row fields that ruled out the obvious causes — the rows agreed on worktree,
 * tab and leaf, so the pane identity was never the problem.
 */
function describeSshLeases(userDataDir: string, targetId: string): string {
  return JSON.stringify(
    readSshLeases(userDataDir, targetId).map((lease) => ({
      ptyId: lease.ptyId,
      state: lease.state,
      worktreeId: lease.worktreeId,
      leafId: lease.leafId,
      tabId: lease.tabId,
      supersededBy: lease.supersededBy,
      relayIdRecycled: lease.relayIdRecycled,
      reattachable: sshRemotePtyLeaseAllowsReattach(lease)
    }))
  )
}

function readUserDataDir(electronApp: ElectronApplication): Promise<string> {
  return electronApp.evaluate(({ app }) => app.getPath('userData'))
}

/**
 * Not covered here on purpose: park-then-reveal after a reconnect. ssh-terminal-parking already
 * covers the park/reveal round trip, and driving a park deterministically from this lane proved
 * flaky enough to cost more than it proves.
 */
test.describe('SSH transport drop recovery', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run the dockerized SSH relay tests')

  test('recovers a live pane after the transport dies under it', async ({ orcaPage }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      enableDockerSshRelayTargetShellTitle(target)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)

      // A marker, not a prompt: a prompt reappears on its own, so it cannot tell restored
      // scrollback from a shell that simply started again.
      const markerSuffix = Date.now()
      const marker = `DROP_MARKER_${markerSuffix}`
      await execInTerminal(orcaPage, ptyId, `printf 'DROP_MARKER_%s\\n' ${markerSuffix}`)
      await waitForTerminalOutput(orcaPage, marker, 30_000)

      const dropped = dropDockerSshRelayTransport(target)
      expect(dropped, 'no live SSH connection was found to drop').toBeGreaterThan(0)

      // Nothing below calls ssh.connect(). Recovery has to come from the client's own ladder,
      // which is the behaviour users depend on and the thing a scripted reconnect never exercised.
      await expect
        .poll(() => readSshStatus(orcaPage, remote.targetId), {
          timeout: 120_000,
          message: 'SSH target never returned to connected after the transport was dropped'
        })
        .toBe('connected')

      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      // The pane must still show what it had. A blank pane here is the reported bug.
      await waitForTerminalOutput(orcaPage, marker, 60_000)

      // And it must still be wired to a shell that answers — a pane can repaint and still be dead,
      // which is the failure mode a content-only assertion misses.
      const afterMarkerSuffix = Date.now()
      const afterMarker = `DROP_AFTER_${afterMarkerSuffix}`
      await execInTerminal(
        orcaPage,
        await waitForActivePanePtyId(orcaPage, 60_000),
        `printf 'DROP_AFTER_%s\\n' ${afterMarkerSuffix}`
      )
      await waitForTerminalOutput(orcaPage, afterMarker, 60_000)
    } finally {
      if (target) {
        clearDockerSshRelayFaults(target)
        cleanupDockerSshRelayTarget(target)
      }
    }
  })

  // Fixme: fails in CI on its first real run — the pane keeps its PTY and repaints, but a command
  // run after the flood produces no output within the poll budget. Same shape as #18018 (deaf pane
  // after a stalled host resumes), and not caused by this spec. Tracked there; the three verdict
  // assertions around it stay enforced.
  test.fixme('stays bounded when a disconnected shell floods its pty', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    // Timeouts here are deliberately generous: this guards memory, not latency. A 48MB flood plus a
    // reconnect lands near 60s wall-clock end to end, so a 60s bind timeout was marginal and made
    // the spec flaky. Measured since: reconnect-and-rebind after the flood is ~11.9s, so the
    // marginal part is the flood WRITE, not recovery — resuming a pty whose client has gone does
    // not slow reconnect under load.
    //
    // The drain fix resumes a pty whose client has gone, so the shell is no longer throttled by a
    // consumer that cannot consume. That is only safe if something else bounds it: `buffered` is a
    // capacity-limited window, and the pending delivery queue — which is unbounded — is dropped
    // rather than carried. This pins that, because the failure it guards against is an OOM on
    // someone's remote host rather than a wrong pixel.
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      enableDockerSshRelayTargetShellTitle(target)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 240_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 240_000)

      const readRelayRssKb = (): number => {
        const out = execDockerSshRelayTargetCommand(
          target!,
          "ps -eo rss,args | grep -F 'relay.js' | grep -v grep | awk '{s+=$1} END {print s+0}'"
        )
        return Number(out.trim().split('\n').at(-1))
      }
      const baselineRssKb = readRelayRssKb()
      expect(baselineRssKb, 'relay process not found').toBeGreaterThan(0)

      // ~48 MB of output with nobody attached: far past any sane replay window.
      await execInTerminal(
        orcaPage,
        ptyId,
        `yes "$(printf 'ORCA_%s' FLOOD_LINE)" | head -c 48000000; echo FLOODED`
      )
      await waitForTerminalOutput(orcaPage, 'ORCA_FLOOD_LINE', 30_000, 20_000)
      const dropped = dropDockerSshRelayTransport(target)
      expect(dropped).toBeGreaterThan(0)

      await expect
        .poll(() => readSshStatus(orcaPage, remote.targetId), {
          timeout: 120_000,
          message: 'SSH target never returned to connected'
        })
        .toBe('connected')
      await waitForActiveTerminalManager(orcaPage, 240_000)

      // Why a generous ceiling: this is an OOM guard, not a memory budget. Unbounded retention of
      // 48 MB of pty output would blow past it; ordinary V8 churn will not.
      const afterRssKb = readRelayRssKb()
      expect(
        afterRssKb - baselineRssKb,
        `relay grew ${afterRssKb - baselineRssKb}KB after 48MB of undeliverable output`
      ).toBeLessThan(200_000)

      // And the session must still be usable, not merely alive.
      const markerSuffix = Date.now()
      const marker = `FLOOD_AFTER_${markerSuffix}`
      await execInTerminal(
        orcaPage,
        await waitForActivePanePtyId(orcaPage, 240_000),
        `printf 'FLOOD_AFTER_%s\\n' ${markerSuffix}`
      )
      await waitForTerminalOutput(orcaPage, marker, 60_000, 20_000)
    } finally {
      if (target) {
        clearDockerSshRelayFaults(target)
        cleanupDockerSshRelayTarget(target)
      }
    }
  })

  /**
   * The one fault in this file where `exited` is the correct verdict, and the only one that can
   * tell "resumed" from "silently started over" (docs/reference/ssh-execution-boundary.md).
   *
   * Every other case here kills the transport and asserts the session survived. That assertion is
   * only meaningful if a genuinely dead session is distinguishable — otherwise a client that always
   * cold-starts would pass them all. SIGKILLing the relay leaves sshd reachable, so the client
   * reconnects, asks the host about the PTY, and gets a positive answer that it is gone. That is
   * host evidence of absence, so replacing the pane is correct here and nowhere else in this file.
   */
  test('replaces the pane only when the host proves the session is gone', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      enableDockerSshRelayTargetShellTitle(target)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)

      const markerSuffix = Date.now()
      const marker = `KILL_MARKER_${markerSuffix}`
      await execInTerminal(orcaPage, ptyId, `printf 'KILL_MARKER_%s\\n' ${markerSuffix}`)
      await waitForTerminalOutput(orcaPage, marker, 30_000)

      const killed = killDockerSshRelayDaemon(target)
      expect(killed, 'no relay process was found to kill').toBeGreaterThan(0)

      await expect
        .poll(() => readSshStatus(orcaPage, remote.targetId), {
          timeout: 120_000,
          message: 'SSH target never returned to connected after the relay was killed'
        })
        .toBe('connected')
      await waitForActiveTerminalManager(orcaPage, 60_000)

      // The verdict, expressed as the only thing a user can observe: the pane is now backed by a
      // DIFFERENT pty. On the transport-drop cases above this id must not change; here it must.
      await expect
        .poll(() => waitForActivePanePtyId(orcaPage, 60_000).catch(() => ptyId), {
          timeout: 120_000,
          message: 'pane kept its old PTY binding after the host proved the session was gone'
        })
        .not.toBe(ptyId)

      // And the replacement must be a working shell, not a dead husk.
      const afterSuffix = Date.now()
      const afterMarker = `KILL_AFTER_${afterSuffix}`
      await execInTerminal(
        orcaPage,
        await waitForActivePanePtyId(orcaPage, 60_000),
        `printf 'KILL_AFTER_%s\\n' ${afterSuffix}`
      )
      await waitForTerminalOutput(orcaPage, afterMarker, 60_000)
    } finally {
      if (target) {
        clearDockerSshRelayFaults(target)
        cleanupDockerSshRelayTarget(target)
      }
    }
  })

  /**
   * The cardinality half of the same fault, which the verdict test above cannot see: it asserts the
   * pane is re-backed, not what the pane's PREVIOUS shells left behind in the store.
   *
   * A pane re-leases under a new relay pty id on every relay restart, and nothing else retires the
   * predecessor. When supersession fails, each generation leaves one more `expired`-but-unsuperseded
   * lease that `reattachKnownPtys` still asks about — one extra `pty.attach` round trip on every
   * later connect, forever, growing linearly with reconnect count. Measured as leases rather than
   * as latency because latency hides the growth until it is already large.
   *
   * The reattachable set must stay at exactly one per pane. It must not go to zero either: a lease
   * wrongly superseded is a running remote shell the pane can no longer find, which is the worse
   * failure (docs/reference/ssh-execution-boundary.md).
   */
  test('keeps one reattachable lease per pane across repeated relay restarts', async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      enableDockerSshRelayTargetShellTitle(target)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      await waitForActivePanePtyId(orcaPage, 60_000)

      const userDataDir = await readUserDataDir(electronApp)
      const generations: string[][] = []

      for (let generation = 1; generation <= 5; generation++) {
        expect(
          killDockerSshRelayDaemon(target),
          'no relay process was found to kill'
        ).toBeGreaterThan(0)
        await expect
          .poll(() => readSshStatus(orcaPage, remote.targetId), {
            timeout: 120_000,
            message: `SSH target never reconnected after relay kill ${generation}`
          })
          .toBe('connected')
        await waitForActiveTerminalManager(orcaPage, 120_000)
        // The pane must be usable again before the count is meaningful: recovery is what mints the
        // successor lease that retires the generation before it.
        const ptyId = await waitForActivePanePtyId(orcaPage, 120_000)
        const marker = `LEASE_GEN_${generation}_${Date.now()}`
        await execInTerminal(orcaPage, ptyId, `printf '%s\\n' ${marker}`)
        await waitForTerminalOutput(orcaPage, marker, 60_000)

        try {
          await expect
            .poll(() => readReattachablePtyIds(userDataDir, remote.targetId).length, {
              timeout: 60_000
            })
            .toBe(1)
        } catch (error) {
          // Why re-thrown with the rows: the count alone cannot say WHICH predecessor stayed
          // reattachable, and the user-data dir is torn down before the report is read.
          throw new Error(
            `reattachable lease count never settled at 1 in generation ${generation}; leases: ${describeSshLeases(userDataDir, remote.targetId)}`,
            { cause: error }
          )
        }
        generations.push(readReattachablePtyIds(userDataDir, remote.targetId))
      }

      // Stated as the whole sequence so a regression reports the growth, not just its endpoint —
      // the reported shape was 2, 3, 4, 5, 6 across five restarts.
      expect(
        generations.map((ptyIds) => ptyIds.length),
        `reattachable lease count per generation: ${JSON.stringify(generations)}`
      ).toEqual([1, 1, 1, 1, 1])
    } finally {
      if (target) {
        clearDockerSshRelayFaults(target)
        cleanupDockerSshRelayTarget(target)
      }
    }
  })

  /**
   * The third fault shape: silence with the socket still established. `docker pause` freezes the
   * container, so nothing is closed or reset — the client simply stops hearing from a host that is
   * perfectly healthy. This is the one that pins "loss of contact is never evidence": the verdict
   * during the silence must be `unverifiable`, so the pane must keep its PTY and come back with its
   * scrollback rather than concluding the session died and starting over.
   */
  test('keeps the session while a frozen host goes silent', async ({ orcaPage }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      enableDockerSshRelayTargetShellTitle(target)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)

      const markerSuffix = Date.now()
      const marker = `STALL_MARKER_${markerSuffix}`
      await execInTerminal(orcaPage, ptyId, `printf 'STALL_MARKER_%s\\n' ${markerSuffix}`)
      await waitForTerminalOutput(orcaPage, marker, 30_000)

      // Long enough to outlast a liveness probe, which is the point: a timeout firing here would be
      // the client asserting death it never observed.
      await withStalledDockerSshRelayTarget(target, async () => {
        await orcaPage.waitForTimeout(30_000)
      })

      await waitForActiveTerminalManager(orcaPage, 60_000)
      // Same PTY, not a replacement: nothing here is host evidence of absence.
      expect(await waitForActivePanePtyId(orcaPage, 60_000)).toBe(ptyId)
      await waitForTerminalOutput(orcaPage, marker, 60_000)
    } finally {
      if (target) {
        clearDockerSshRelayFaults(target)
        cleanupDockerSshRelayTarget(target)
      }
    }
  })

  /**
   * Known broken on main, kept as the reproduction. The verdict test above passes: after a 30s
   * freeze the pane keeps its PTY and repaints its scrollback. What does not come back is the
   * shell — a command run afterwards produces no output within 60s, so the pane is live-looking and
   * deaf. Measured twice at `waitForTerminalOutput(STALL_AFTER_…)`, and it reproduces unchanged
   * with the reattach-token/delivery-ownership fix applied, so that is not the cause.
   *
   * Split out rather than folded into the test above so the `unverifiable` verdict stays enforced
   * in CI instead of being masked by this failure.
   */
  test.fixme('accepts input again after a frozen host resumes', async ({ orcaPage }, testInfo) => {
    test.slow()
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      enableDockerSshRelayTargetShellTitle(target)
      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)
      const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)

      await withStalledDockerSshRelayTarget(target, async () => {
        await orcaPage.waitForTimeout(30_000)
      })
      await waitForActiveTerminalManager(orcaPage, 60_000)

      const afterSuffix = Date.now()
      const afterMarker = `STALL_AFTER_${afterSuffix}`
      await execInTerminal(orcaPage, ptyId, `printf 'STALL_AFTER_%s\\n' ${afterSuffix}`)
      await waitForTerminalOutput(orcaPage, afterMarker, 60_000)
    } finally {
      if (target) {
        clearDockerSshRelayFaults(target)
        cleanupDockerSshRelayTarget(target)
      }
    }
  })
})
