/**
 * Kernel identity of the shells a Docker SSH relay is hosting.
 *
 * Why not the pid alone: a pid proves nothing across a restart. Journey 1
 * caught a case where every id matched while the process underneath was new,
 * so this pairs each pid with the kernel's start time for it (field 22 of
 * /proc/<pid>/stat, in clock ticks since boot). A respawned look-alike gets a
 * different start time even if it reuses the pid, and the boot id makes the
 * pair meaningless to compare across a container restart.
 */
import {
  execDockerSshRelayTargetCommand,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

export type DockerSshRemoteShellIdentity = {
  pid: number
  /** Clock ticks since boot, from /proc/<pid>/stat. */
  startTicks: number
  bootId: string
  paneKey: string | null
  tabId: string | null
  worktreeId: string | null
}

// Same shape as the remote-PTY census (a direct child of a detached relay whose
// stdin is a pts), plus start time. Kept separate from that helper so Journey 7
// keeps reading exactly what it reads today.
const LIST_RELAY_SHELL_IDENTITIES_COMMAND = `
boot="$(cat /proc/sys/kernel/random/boot_id)"
relay_pids=()
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  argv=()
  mapfile -d '' -t argv < "$proc/cmdline" 2>/dev/null || continue
  [ "\${argv[1]##*/}" = relay.js ] || continue
  case " \${argv[*]:2} " in *" --detached "*) relay_pids+=("\${proc##*/}") ;; esac
done
[ \${#relay_pids[@]} -gt 0 ] || exit 0
for proc in /proc/[0-9]*; do
  [ -r "$proc/status" ] || continue
  ppid="$(awk '/^PPid:/{print $2}' "$proc/status" 2>/dev/null)"
  [ -n "$ppid" ] || continue
  matched=
  for relay in "\${relay_pids[@]}"; do
    if [ "$relay" = "$ppid" ]; then matched=1; break; fi
  done
  [ -n "$matched" ] || continue
  pts="$(readlink "$proc/fd/0" 2>/dev/null)"
  case "$pts" in /dev/pts/*) ;; *) continue ;; esac
  stat_line="$(cat "$proc/stat" 2>/dev/null)" || continue
  # Why the trailing ')' split: the comm field can contain spaces, so fields are
  # only stable after it. starttime is field 22 overall = field 20 after comm.
  after_comm="\${stat_line#*) }"
  start="$(printf '%s' "$after_comm" | awk '{print $20}')"
  [ -n "$start" ] || continue
  pane=; tab=; worktree=
  [ -r "$proc/environ" ] || continue
  while IFS= read -r -d '' entry; do
    case "$entry" in
      ORCA_PANE_KEY=*) pane="\${entry#ORCA_PANE_KEY=}" ;;
      ORCA_TAB_ID=*) tab="\${entry#ORCA_TAB_ID=}" ;;
      ORCA_WORKTREE_ID=*) worktree="\${entry#ORCA_WORKTREE_ID=}" ;;
    esac
  done < "$proc/environ" || continue
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "\${proc##*/}" "$start" "$boot" "\${pane:--}" "\${tab:--}" "\${worktree:--}"
done
exit 0
`

function optional(value: string | undefined): string | null {
  return value === undefined || value === '' || value === '-' ? null : value
}

export function readDockerSshRemoteShellIdentities(
  target: DockerSshRelayTarget
): DockerSshRemoteShellIdentity[] {
  const output = execDockerSshRelayTargetCommand(target, LIST_RELAY_SHELL_IDENTITIES_COMMAND)
  if (!output) {
    return []
  }
  return output
    .split('\n')
    .map((line) => {
      const [rawPid, rawStart, bootId, paneKey, tabId, worktreeId] = line.split('\t')
      const pid = Number(rawPid)
      const startTicks = Number(rawStart)
      // Why throw: a half-read /proc row must make the caller's poll retry, not
      // enter the census as pid 0 and silently satisfy an equality assertion.
      if (!Number.isInteger(pid) || !Number.isInteger(startTicks) || !bootId) {
        throw new Error(`Unexpected remote shell identity row: ${line}`)
      }
      return {
        pid,
        startTicks,
        bootId,
        paneKey: optional(paneKey),
        tabId: optional(tabId),
        worktreeId: optional(worktreeId)
      }
    })
    .sort((left, right) => left.pid - right.pid)
}

/** Stable, comparable rendering of one host's shells: pid, start time, pane. */
export function describeDockerSshRemoteShellIdentities(
  identities: DockerSshRemoteShellIdentity[]
): string[] {
  return identities
    .map((shell) => `${shell.pid}@${shell.startTicks}:${shell.bootId} pane=${shell.paneKey ?? '-'}`)
    .sort()
}
