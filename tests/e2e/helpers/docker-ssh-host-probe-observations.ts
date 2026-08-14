/**
 * "Did anything dial this host?" — measured on the host, not in a log line the
 * app controls.
 *
 * Three independent signals, because each one alone can miss a probe:
 *  - `acceptedAuths` is cumulative (sshd's own auth log), so a connection that
 *    opens and closes between two samples still shows up;
 *  - `sshdSessions` catches a connection that is still open;
 *  - `connectBridges` catches Orca's `relay.js --connect` transport even if the
 *    sshd session were somehow invisible.
 *
 * `docker exec` does not go through sshd, so this helper's own probes never
 * contaminate the counters they read.
 */
import { spawnSync } from 'node:child_process'
import {
  execDockerSshRelayTargetCommand,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

export type DockerSshHostProbeObservation = {
  /** Cumulative count of completed public-key authentications since boot. */
  acceptedAuths: number
  /** Live `sshd: root@...` sessions right now. */
  sshdSessions: number
  /** Live `relay.js --connect` transport bridges right now. */
  connectBridges: number
  /** `kind pid cmdline` for each of the above, so a failure names the process. */
  transportProcesses: string[]
}

// Why argv[0] and not the joined cmdline: this probe runs as `bash -lc <script>`,
// so the script text is itself a process cmdline in /proc. Matching on the
// joined string counts the probe as a connection — the exact false positive
// that would make "nothing dialed this host" unfalsifiable. sshd rewrites argv[0]
// to its session title, and the relay bridge is a node process, so both kinds are
// identified by argv[0] plus a needle that is assembled at runtime rather than
// written as one literal.
const LIST_LIVE_TRANSPORT_COMMAND = `
needle="relay.js --con""nect"
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  argv=()
  mapfile -d '' -t argv < "$proc/cmdline" 2>/dev/null || continue
  kind=
  case "\${argv[0]}" in
    "sshd: root@"*) kind=sshd ;;
  esac
  if [ "\${argv[0]##*/}" = node ]; then
    case "\${argv[*]}" in *"$needle"*) kind=bridge ;; esac
  fi
  [ -n "$kind" ] || continue
  printf '%s\\t%s\\t%s\\n' "$kind" "\${proc##*/}" "\${argv[*]}"
done
exit 0
`

function countAcceptedAuths(target: DockerSshRelayTarget): number {
  // Why docker logs and not a file inside the container: sshd runs with -e, so
  // its auth log is the container's stderr and cannot be truncated by anything
  // the app does on the host. Both streams are read because that is the one
  // sshd writes to — reading stdout alone silently returns zero forever.
  const result = spawnSync('docker', ['logs', target.containerName], {
    encoding: 'utf8',
    timeout: 30_000
  })
  if (result.status !== 0) {
    throw new Error(`docker logs failed for ${target.containerName}: ${result.stderr}`)
  }
  const logs = `${result.stdout}\n${result.stderr}`
  return logs.split('\n').filter((line) => line.includes('Accepted publickey for')).length
}

export function readDockerSshHostProbeObservation(
  target: DockerSshRelayTarget
): DockerSshHostProbeObservation {
  const acceptedAuths = countAcceptedAuths(target)
  const output = execDockerSshRelayTargetCommand(target, LIST_LIVE_TRANSPORT_COMMAND)
  const rows = output ? output.split('\n') : []
  const transportProcesses: string[] = []
  let sshdSessions = 0
  let connectBridges = 0
  for (const row of rows) {
    const [kind, pid, cmdline] = row.split('\t')
    if ((kind !== 'sshd' && kind !== 'bridge') || !pid || !cmdline) {
      throw new Error(`Unexpected SSH transport row for ${target.containerName}: ${row}`)
    }
    transportProcesses.push(`${kind} ${pid} ${cmdline}`)
    if (kind === 'sshd') {
      sshdSessions += 1
    } else {
      connectBridges += 1
    }
  }
  return { acceptedAuths, sshdSessions, connectBridges, transportProcesses }
}

export function describeDockerSshHostProbeObservation(
  observation: DockerSshHostProbeObservation
): string {
  return `auths=${observation.acceptedAuths} sshd=${observation.sshdSessions} bridges=${observation.connectBridges} [${observation.transportProcesses.join(' | ')}]`
}
