import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  cleanupDockerSshRelayTarget,
  enableDockerSshRelayTargetShellTitle,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import { execDockerSshRelayTargetCommand } from './helpers/docker-ssh-relay-target'
import {
  clearDockerSshRelayFaults,
  dropDockerSshRelayTransport
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
 * Faults come from docker-ssh-relay-faults: sshd's per-connection forks are killed while the
 * listening daemon and every relay process survive.
 */
async function readSshStatus(orcaPage: Parameters<typeof getTerminalContent>[0], targetId: string) {
  return orcaPage.evaluate(
    (targetId) => window.__store?.getState().sshConnectionStates.get(targetId)?.status ?? null,
    targetId
  )
}

/**
 * Not covered here on purpose: park-then-reveal after a reconnect. A spec for it was written and
 * run — the reveal comes back substantially whole, with an intermittent one-line drop at the
 * reconnect seam (1 run in 3) — but the park step itself races ("did not park") often enough that
 * the spec was flaky in the lane that exists to catch bulk loss, which costs more than it proves.
 * The measurement is recorded in docs/ssh-v3-redesign.html; ssh-terminal-parking already covers the
 * park/reveal round trip. Re-add this once parking can be driven deterministically.
 *
 * One dead end already ruled out, so it is not re-run: the seam looked like the wholesale
 * `pendingOutputByPty.delete(id)` in pty-handler's attach path dropping bytes the bounded replay
 * had trimmed. Instrumenting that call on an overflowing run measured
 * `pendLen=34340 replayLen=102400 coveredByReplay=true` — the pending bytes are entirely inside the
 * replay, so that is not the cause. That rules out the mechanism, not the association: both this
 * seam (1 in 3) and the ssh-terminal-parking flake (1 in 4) are still "a park-reveal intermittently
 * loses one line", so they may yet be one defect whose cause nobody has found.
 *
 * Narrowed once already: the splice consumer in pty-connection.ts (setRestoredSnapshotBaseline plus
 * the dedupe at the reconcile site) was read closely and shows NO off-by-one — the window is
 * (windowStart, baseline], a chunk spanning the baseline is sliced at baseline-startSeq, and a
 * detected gap forces a fresh restore rather than writing through. So the arithmetic is not the
 * suspect.
 *
 * Narrowed a third time, by instrumenting a failing reveal: main's model HAS the line. Logging
 * pty:getMainBufferSnapshot on ssh-terminal-parking runs gave
 * `seq=125208 pendStart=125157 bodyLen=125137 hasPadDone=true src=headless` on failing runs as well
 * as passing ones. So the snapshot carries the content the reveal is missing, and the remaining
 * suspect is the RENDERER's application of that snapshot — whether it lands at all, lands partially,
 * or simply does not finish inside the 60s poll while writing ~125KB of ANSI into a fresh xterm.
 * NOT slowness: raising that poll from 60s to 240s still failed 3 of 4 runs, so four minutes of
 * waiting does not heal it — the content genuinely never reaches the pane.
 *
 * Four causes now ruled out by measurement: the wholesale pending delete, the splice arithmetic,
 * main's model (the snapshot demonstrably carries the line), and paint throughput. What is left is
 * that the renderer's reveal does not apply the snapshot it was given, or discards it after
 * applying. Start there.
 *
 * Best lead for whoever picks it up, unverified: the loss is more likely in the snapshot/live
 * SPLICE than in the snapshot. main already knows serialize races the emulator's writeChain —
 * RuntimeHeadlessTerminal.outputSequence exists for exactly that ("return the seq actually painted
 * into this emulator, not the latest PTY seq", orca-runtime.ts), and pty:getMainBufferSnapshot
 * returns both `seq` and `pendingDeliveryStartSeq` so the consumer can append what the snapshot did
 * not contain. A single trailing line is precisely what an off-by-one there would cost. Check the
 * consumer of those two fields before instrumenting anything deeper.
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
      const marker = `DROP_MARKER_${Date.now()}`
      await execInTerminal(orcaPage, ptyId, `echo ${marker}`)
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
      const afterMarker = `DROP_AFTER_${Date.now()}`
      await execInTerminal(
        orcaPage,
        await waitForActivePanePtyId(orcaPage, 60_000),
        `echo ${afterMarker}`
      )
      await waitForTerminalOutput(orcaPage, afterMarker, 60_000)
    } finally {
      if (target) {
        clearDockerSshRelayFaults(target)
        cleanupDockerSshRelayTarget(target)
      }
    }
  })

  test('stays bounded when a disconnected shell floods its pty', async ({ orcaPage }, testInfo) => {
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
      await execInTerminal(orcaPage, ptyId, 'yes ORCA_FLOOD_LINE | head -c 48000000; echo FLOODED')
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
      const marker = `FLOOD_AFTER_${Date.now()}`
      await execInTerminal(
        orcaPage,
        await waitForActivePanePtyId(orcaPage, 240_000),
        `echo ${marker}`
      )
      await waitForTerminalOutput(orcaPage, marker, 60_000, 20_000)
    } finally {
      if (target) {
        clearDockerSshRelayFaults(target)
        cleanupDockerSshRelayTarget(target)
      }
    }
  })

  test('keeps output the remote produced while the transport was down', async ({
    orcaPage
  }, testInfo) => {
    test.slow()
    // This was broken until the relay stopped letting a departed client wedge the shell.
    //
    // Output backpressure pauses the pty itself and only resumes once pending bytes drain to a
    // client. When the transport died mid-stream there was none, so the pty stayed paused and the
    // shell blocked on a pty nobody read. Measured on both sides at the time: the client's reattach
    // replay held only SEQ-1..120 (1427 bytes), and the relay's own ingress had seen nothing past
    // SEQ-100 — so the outage was not merely undelivered, it was never produced. See
    // releaseUndeliverableOutput in src/relay/pty-handler.ts.
    //
    // Recorded because two fixes were built against the wrong layer first, and both left this
    // number byte-identical at 459 missing — they changed who consumes a payload that was empty:
    //   1. Relay eligibility — activate() compares record.clientId, and setWrite() revives the
    //      primary client with its id intact, so a reconnect reads as 'existing' and checkpointed
    //      recovery never runs. Still true, still worth fixing, but not what caused this.
    //   2. Renderer paint source — a pane that both parked and reconnected takes the park branch,
    //      which trusts main's headless model.
    // Also still true: seedHeadlessTerminal (orca-runtime.ts) returns early whenever a model already
    // exists, which on an in-process reconnect it always does, so main's model stays stale.
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

      // A dense numbered sequence is the only way to see a hole. "The pane has content" and "the
      // marker came back" both stay true while an arbitrary slice of the middle is missing, which
      // is exactly the shape of loss a replay window causes.
      const total = 600
      await execInTerminal(
        orcaPage,
        ptyId,
        `for i in $(seq 1 ${total}); do printf 'SEQ-%04d\\n' "$i"; sleep 0.025; done; printf 'SEQ-%s\\n' FIN`
      )
      await waitForTerminalOutput(orcaPage, 'SEQ-0040', 30_000, 20_000)

      // Drop mid-stream: the shell keeps writing to a PTY the relay still owns, so these lines are
      // produced while no client is attached to receive them.
      const dropped = dropDockerSshRelayTransport(target)
      expect(dropped, 'no live SSH connection was found to drop').toBeGreaterThan(0)

      await expect
        .poll(() => readSshStatus(orcaPage, remote.targetId), {
          timeout: 120_000,
          message: 'SSH target never returned to connected after the transport was dropped'
        })
        .toBe('connected')
      await waitForActiveTerminalManager(orcaPage, 240_000)
      await waitForActivePanePtyId(orcaPage, 240_000)

      // Why built at runtime: the pane echoes the command line, so a sentinel spelled out in the
      // command satisfies a naive wait before the shell has produced anything. This one only exists
      // once printf runs.
      const finished = 'SEQ-FIN'
      await waitForTerminalOutput(orcaPage, finished, 120_000, 400_000)

      const content = await getTerminalContent(orcaPage, 400_000)
      const seen = new Set([...content.matchAll(/SEQ-(\d{4})/g)].map((match) => Number(match[1])))
      const missing: number[] = []
      for (let i = 1; i <= total; i += 1) {
        if (!seen.has(i)) {
          missing.push(i)
        }
      }
      // Reported as a range because a contiguous block names the outage directly, while a count
      // alone cannot distinguish "lost the outage" from "scrollback trimmed the start".
      const detail =
        missing.length === 0
          ? 'none'
          : `${missing.length} missing, ${missing.at(0)}..${missing.at(-1)}`
      expect(missing, `output produced during the outage was lost: ${detail}`).toEqual([])
    } finally {
      if (target) {
        clearDockerSshRelayFaults(target)
        cleanupDockerSshRelayTarget(target)
      }
    }
  })
})
