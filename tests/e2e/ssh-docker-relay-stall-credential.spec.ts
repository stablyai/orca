import type { Page } from '@playwright/test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { getTerminalContent } from './helpers/terminal-pane-identity'
import {
  cleanupDockerSshRelayTarget,
  enableDockerSshRelayTargetShellTitle,
  execDockerSshRelayTargetControlCommand,
  startDockerSshRelayTarget,
  type DockerSshRelayTarget
} from './helpers/docker-ssh-relay-target'
import { connectDockerSshRelayTarget } from './helpers/docker-ssh-relay-connection'
import {
  clearDockerSshRelayFaults,
  continueDockerSshRelayProcesses,
  stopDockerSshRelayProcesses
} from './helpers/docker-ssh-relay-faults'

const RUN_DOCKER_SSH = process.env.ORCA_E2E_SSH_DOCKER === '1'

// Why 20 s: the live incident held both relay pids for 20 s, which is exactly the client mux
// liveness timeout, so the client declares the link lost and redeploys while the host is frozen.
const STALL_MS = 20_000

type RelayEndpointSnapshot = {
  daemonPid: string
  credentialInode: string
  credential: string
  logLines: number
}

async function readSshStatus(orcaPage: Page, targetId: string): Promise<string | null> {
  return orcaPage.evaluate(
    (targetId) => window.__store?.getState().sshConnectionStates.get(targetId)?.status ?? null,
    targetId
  )
}

/**
 * Everything the wedge changed, read from the host: the daemon that owns the socket, the
 * credential file's identity and content, and how far the relay log had got. Read through the
 * control shell (no login profile) so the numbers are the host's, not a shell banner's.
 */
function snapshotRelayEndpoint(target: DockerSshRelayTarget): RelayEndpointSnapshot {
  const output = execDockerSshRelayTargetControlCommand(
    target,
    `
sock=$(find /root/.orca-remote -maxdepth 2 -name 'relay-*.sock' -type s | head -n 1)
[ -n "$sock" ] || { echo NO_SOCKET; exit 0; }
daemon=""
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  argv=()
  mapfile -d '' -t argv < "$proc/cmdline" 2>/dev/null || continue
  [ "\${argv[1]##*/}" = relay.js ] || continue
  case " \${argv[*]} " in *" --detached "*) daemon="\${proc##*/}" ;; esac
done
echo "DAEMON=$daemon"
echo "INODE=$(stat -c %i "$sock.credential")"
echo "CREDENTIAL=$(cat "$sock.credential")"
echo "LOGLINES=$(wc -l < "$(dirname "$sock")/relay.log")"
`
  )
  const field = (name: string): string =>
    output
      .split('\n')
      .find((line) => line.startsWith(`${name}=`))
      ?.slice(name.length + 1)
      .trim() ?? ''
  const snapshot = {
    daemonPid: field('DAEMON'),
    credentialInode: field('INODE'),
    credential: field('CREDENTIAL'),
    logLines: Number(field('LOGLINES'))
  }
  if (!snapshot.daemonPid || !snapshot.credential || !Number.isInteger(snapshot.logLines)) {
    throw new Error(`Could not snapshot the relay endpoint on ${target.containerName}: ${output}`)
  }
  return snapshot
}

function readRelayLogSince(target: DockerSshRelayTarget, lines: number): string {
  return execDockerSshRelayTargetControlCommand(
    target,
    `tail -n +${lines + 1} "$(dirname "$(find /root/.orca-remote -maxdepth 2 -name 'relay-*.sock' -type s | head -n 1)")/relay.log"`
  )
}

/**
 * The live incident (Orca 1.4.198, 2026-09-05): both relay processes SIGSTOPped for 20 s, then
 * continued. The client redeployed while the host was frozen, its fresh daemon lost the bind but
 * had already rewritten the endpoint credential, and the surviving daemon then refused every
 * client forever — "Endpoint credential mismatch" every ~20 s with a PTY and zero clients, until
 * someone sent it SIGTERM by hand.
 *
 * Three things must hold after the same injection here. The credential file is byte-for-byte
 * and inode-for-inode what it was, because only a daemon that owns the socket may write it. The
 * same daemon still owns the socket, because a relay that merely went quiet is `live`, not
 * `exited`, and is never replaced (docs/reference/ssh-execution-boundary.md). And the relay log
 * has no mismatch line at all, because the wedge is gone rather than healed after the fact.
 */
test.describe('SSH relay stall does not rotate the endpoint credential', () => {
  test.skip(!RUN_DOCKER_SSH, 'Set ORCA_E2E_SSH_DOCKER=1 to run the dockerized SSH relay tests')

  test('keeps the same daemon and credential across a 20s relay freeze', async ({
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

      const runId = Date.now()
      await execInTerminal(orcaPage, ptyId, `printf 'STALL_BEFORE_%s\\n' ${runId}`)
      await waitForTerminalOutput(orcaPage, `STALL_BEFORE_${runId}`, 30_000)
      const before = snapshotRelayEndpoint(target)

      const stopped = stopDockerSshRelayProcesses(target)
      expect(stopped, 'no relay process was found to freeze').toBeGreaterThan(0)
      testInfo.annotations.push({ type: 'relay-processes-stopped', description: String(stopped) })

      // Sent into the freeze, like the orchestration send that was in flight in the incident.
      // The oracle below is that it is delivered at most once; whether it is delivered at all
      // depends on which side of the liveness timeout the mux disposes, which this spec does not
      // pin — the brief's exactly-once guarantee lives at the mailbox, not the PTY byte stream.
      await execInTerminal(orcaPage, ptyId, `printf 'STALL_DURING_%s\\n' ${runId}`)
      await orcaPage.waitForTimeout(STALL_MS)
      const continued = continueDockerSshRelayProcesses(target)
      expect(continued).toBe(stopped)

      await expect
        .poll(() => readSshStatus(orcaPage, remote.targetId), {
          timeout: 120_000,
          message: 'SSH target never returned to connected after the relay was continued'
        })
        .toBe('connected')
      await waitForActiveTerminalManager(orcaPage, 60_000)

      // Same pty: the session was live the whole time, so nothing may have replaced it.
      await expect
        .poll(() => waitForActivePanePtyId(orcaPage, 60_000), { timeout: 60_000 })
        .toBe(ptyId)
      await execInTerminal(orcaPage, ptyId, `printf 'STALL_AFTER_%s\\n' ${runId}`)
      await waitForTerminalOutput(orcaPage, `STALL_AFTER_${runId}`, 60_000)

      const after = snapshotRelayEndpoint(target)
      expect(after.daemonPid, 'a second daemon replaced the frozen one').toBe(before.daemonPid)
      expect(after.credential, 'the endpoint credential was rotated').toBe(before.credential)
      expect(after.credentialInode, 'the endpoint credential file was rewritten').toBe(
        before.credentialInode
      )

      const logSince = readRelayLogSince(target, before.logLines)
      testInfo.annotations.push({ type: 'relay-log-since-stall', description: logSince })
      expect(logSince).not.toContain('Endpoint credential mismatch')
      expect(logSince).not.toContain('Socket path already in use')

      const content = await getTerminalContent(orcaPage, 20_000)
      const duringCount = content.split(`STALL_DURING_${runId}`).length - 1
      testInfo.annotations.push({
        type: 'in-stall-input-delivered',
        description: String(duringCount)
      })
      // The echo of the typed command counts once; the printf output counts once more.
      expect(
        duringCount,
        'input sent during the stall was delivered more than once'
      ).toBeLessThanOrEqual(2)
    } finally {
      if (target) {
        clearDockerSshRelayFaults(target)
        cleanupDockerSshRelayTarget(target)
      }
    }
  })
})
