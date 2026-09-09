/**
 * Adversarial resource-accumulation probe for the SSH relay.
 *
 * Covers claims no unit test can reach, measured on the remote host itself:
 *  - #17914 / #17920: PTY master fds are close-on-exec, so /dev/pts and the
 *    relay's fd table must not grow per terminal beyond the terminals
 *    themselves. #17914 patches the app and terminal daemon; the relay installs
 *    node-pty from npm on the remote host, so #17920 ships the same patch as a
 *    relay asset and rebuilds there. Only a remote host can judge that second
 *    half, which is why leakedMasterFdCount is measured on the container.
 *  - #17817/#17821/#17831: repeated disconnect/reconnect must not accumulate
 *    relay processes, orphan PTYs, or fds.
 *
 * Requires: ORCA_E2E_SSH_DOCKER=1 and Docker available.
 */
import { expect, test } from './helpers/orca-app'
import {
  cleanupDockerSshRelayTarget,
  execDockerSshRelayTargetCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import {
  connectDockerSshRelayTarget,
  reconnectDockerSshRelayTarget
} from './helpers/docker-ssh-relay-connection'
import { readDockerSshRelayProcessSnapshots } from './helpers/docker-ssh-relay-processes'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  focusLastTerminalPane,
  splitActiveTerminalPane,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'
const TERMINAL_COUNT = 6
const RECONNECT_CYCLES = 5

type RemoteResourceSample = {
  ptsCount: number
  relayFdCount: number
  relayProcessCount: number
  nodeProcessCount: number
  /**
   * PTY master fds held by processes other than the relay. A master fd without
   * FD_CLOEXEC is inherited by every later-spawned child, so this grows ~N^2/2
   * across N terminals when the close-on-exec fix is absent (#17914).
   */
  leakedMasterFdCount: number
}

const COUNT_LEAKED_MASTER_FDS = [
  'total=0',
  'for p in $(ls /proc | grep -E "^[0-9]+$"); do',
  '  cmd=$(tr "\\0" " " < /proc/$p/cmdline 2>/dev/null || true)',
  '  case "$cmd" in *relay.js*) continue;; esac',
  '  n=$(ls -l /proc/$p/fd 2>/dev/null | grep -c "ptmx" || true)',
  '  total=$((total+n))',
  'done',
  'echo $total'
].join('\n')

const DESCRIBE_MASTER_FD_HOLDERS = [
  'for p in $(ls /proc | grep -E "^[0-9]+$"); do',
  '  cmd=$(tr "\\0" " " < /proc/$p/cmdline 2>/dev/null || true)',
  '  n=$(ls -l /proc/$p/fd 2>/dev/null | grep -c "ptmx" || true)',
  '  if [ "$n" != "0" ]; then echo "$p n=$n cmd=$cmd"; fi',
  'done'
].join('\n')

function sampleRemoteResources(target: DockerSshRelayTarget): RemoteResourceSample {
  const groups = readDockerSshRelayProcessSnapshots(target)
  // Why: fd growth is only meaningful against the relay that owns the PTYs, so read
  // the table of every relay group and sum, rather than assuming a single relay.
  const relayFdCount = groups.reduce((total, group) => {
    const raw = execDockerSshRelayTargetCommand(
      target,
      `ls /proc/${group.relayPid}/fd 2>/dev/null | wc -l`
    )
    return total + Number(raw.trim() || '0')
  }, 0)
  const ptsCount = Number(
    execDockerSshRelayTargetCommand(target, 'ls /dev/pts | grep -c "^[0-9]" || true').trim() || '0'
  )
  const nodeProcessCount = Number(
    execDockerSshRelayTargetCommand(target, 'pgrep -c node || true').trim() || '0'
  )
  const leakedMasterFdCount = Number(
    execDockerSshRelayTargetCommand(target, COUNT_LEAKED_MASTER_FDS).trim() || '0'
  )
  return {
    ptsCount,
    relayFdCount,
    relayProcessCount: groups.length,
    nodeProcessCount,
    leakedMasterFdCount
  }
}

test.describe('Docker SSH relay resource accumulation', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run Docker-backed SSH tests.')
  test.skip(process.platform === 'win32', 'Uses POSIX /proc and /dev/pts probes.')

  test('does not accumulate pts devices, relay fds, or relay processes @resource-accumulation', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    test.setTimeout(420_000)
    let target: DockerSshRelayTarget | null = null
    try {
      target = startDockerSshRelayTarget(testInfo)
      const captured = target
      registerPostElectronShutdownCleanup(async () => {
        cleanupDockerSshRelayTarget(captured)
      })

      await waitForSessionReady(orcaPage)
      await waitForActiveWorktree(orcaPage)
      const remote = await connectDockerSshRelayTarget(orcaPage, target)
      await ensureTerminalVisible(orcaPage, 45_000)
      await waitForActiveTerminalManager(orcaPage, 60_000)

      const runId = String(Date.now())
      const firstPtyId = await waitForActivePanePtyId(orcaPage, 60_000)
      await execInTerminal(orcaPage, firstPtyId, `echo PANE_READY_${runId}_0`)
      await waitForTerminalOutput(orcaPage, `PANE_READY_${runId}_0`, 60_000)

      const baseline = sampleRemoteResources(target)
      const samples: RemoteResourceSample[] = []

      // Open N more terminals; each must cost a bounded, roughly constant amount.
      for (let index = 1; index < TERMINAL_COUNT; index += 1) {
        await splitActiveTerminalPane(orcaPage, 'vertical')
        await focusLastTerminalPane(orcaPage)
        const ptyId = await waitForActivePanePtyId(orcaPage, 60_000)
        await execInTerminal(orcaPage, ptyId, `echo PANE_READY_${runId}_${index}`)
        await waitForTerminalOutput(orcaPage, `PANE_READY_${runId}_${index}`, 60_000)
        samples.push(sampleRemoteResources(target))
      }

      const withTerminals = samples.at(-1)!
      const openedTerminals = TERMINAL_COUNT - 1
      const ptsGrowth = withTerminals.ptsCount - baseline.ptsCount
      const fdGrowth = withTerminals.relayFdCount - baseline.relayFdCount
      const fdPerTerminal = fdGrowth / openedTerminals

      console.log(
        `[resource-accumulation] open ${JSON.stringify({
          baseline,
          withTerminals,
          openedTerminals,
          ptsGrowth,
          fdGrowth,
          fdPerTerminal
        })}`
      )

      console.log(
        `[resource-accumulation] master-fd holders\n${execDockerSshRelayTargetCommand(
          target,
          DESCRIBE_MASTER_FD_HOLDERS
        )}`
      )

      // Each remote terminal legitimately costs one pts device.
      expect(ptsGrowth).toBeLessThanOrEqual(openedTerminals)
      // Why: a master fd that leaks into every child would push this well past a
      // small constant per terminal. Allow slack for the relay's own bookkeeping.
      expect(fdPerTerminal).toBeLessThanOrEqual(4)
      // Why an equality-shaped bound rather than slack: a master fd that is not close-on-exec is
      // inherited by every later child, so terminal k adds k of them (1+2+3+4+5 = 15 was the
      // observed pre-fix signature). With #17914's patch reaching the relay host through #17920
      // no non-relay process holds a master at all, so any growth here means the relay's node-pty
      // rebuild did not take on this host — which is exactly what this probe exists to catch.
      expect(withTerminals.leakedMasterFdCount).toBeLessThanOrEqual(baseline.leakedMasterFdCount)
      expect(withTerminals.relayProcessCount).toBe(1)

      // Repeated reconnects must not accumulate anything on the host.
      const reconnectSamples: RemoteResourceSample[] = []
      for (let cycle = 0; cycle < RECONNECT_CYCLES; cycle += 1) {
        await reconnectDockerSshRelayTarget(orcaPage, remote.targetId)
        reconnectSamples.push(sampleRemoteResources(target))
      }
      console.log(`[resource-accumulation] reconnects ${JSON.stringify(reconnectSamples)}`)

      const first = reconnectSamples[0]
      const last = reconnectSamples.at(-1)!
      expect(last.relayProcessCount).toBe(1)
      // Why: the interesting failure is monotonic growth across cycles, not the
      // absolute count, so compare the last cycle against the first.
      expect(last.ptsCount).toBeLessThanOrEqual(first.ptsCount)
      expect(last.relayFdCount).toBeLessThanOrEqual(first.relayFdCount + 4)
      expect(last.nodeProcessCount).toBeLessThanOrEqual(first.nodeProcessCount)
      expect(last.leakedMasterFdCount).toBeLessThanOrEqual(first.leakedMasterFdCount)
    } finally {
      if (target) {
        cleanupDockerSshRelayTarget(target)
      }
    }
  })
})
