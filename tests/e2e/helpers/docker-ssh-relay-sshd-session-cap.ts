/**
 * The container's own view of its SSH session cap.
 *
 * `MaxSessions` bounds concurrent session channels *per network connection*, so
 * a leaked connection is the observable that a cap of 1 exposes: sshd forks one
 * `sshd: <user>@<tty>` process per authenticated connection, and that count is
 * the number of cap slots the host is currently holding open for Orca.
 */
import {
  execDockerSshRelayTargetCommand,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

export type DockerSshdSessionCap = {
  /** What sshd actually enforces, read back from its effective config. */
  maxSessions: number
  /** One per authenticated network connection, each holding up to `maxSessions` channels. */
  connectionPids: number[]
}

// `sshd -T` prints the effective configuration, so this reads what the daemon
// enforces rather than what the fixture wrote into sshd_config.
const READ_SSHD_SESSION_CAP_COMMAND = `
/usr/sbin/sshd -T | awk '/^maxsessions /{print "max\\t" $2}'
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  argv=()
  mapfile -d '' -t argv < "$proc/cmdline" 2>/dev/null || continue
  case "\${argv[*]}" in
    "sshd: "*"@"*) printf 'conn\\t%s\\n' "\${proc##*/}" ;;
  esac
done
exit 0
`

export function readDockerSshdSessionCap(target: DockerSshRelayTarget): DockerSshdSessionCap {
  const output = execDockerSshRelayTargetCommand(target, READ_SSHD_SESSION_CAP_COMMAND)
  let maxSessions: number | null = null
  const connectionPids: number[] = []
  for (const line of output.split('\n')) {
    if (!line) {
      continue
    }
    const [kind, value] = line.split('\t')
    if (kind === 'max') {
      maxSessions = Number(value)
      continue
    }
    if (kind !== 'conn') {
      throw new Error(`Unexpected sshd session-cap row: ${line}`)
    }
    const pid = Number(value)
    // Why throw: a vanished /proc entry must make the caller re-read rather than
    // fold a half-read row into the census as connection pid 0.
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`Unexpected sshd connection pid: ${line}`)
    }
    connectionPids.push(pid)
  }
  if (maxSessions === null || !Number.isInteger(maxSessions)) {
    throw new Error(`sshd did not report a MaxSessions value: ${output}`)
  }
  return { maxSessions, connectionPids: connectionPids.sort((left, right) => left - right) }
}
