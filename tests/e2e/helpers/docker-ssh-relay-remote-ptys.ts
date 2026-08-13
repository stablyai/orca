import {
  execDockerSshRelayTargetCommand,
  type DockerSshRelayTarget
} from './docker-ssh-relay-target'

/** One live remote shell the relay is hosting on the Docker target. */
export type DockerSshRelayRemotePty = {
  pid: number
  relayPid: number
  pts: string
  /** Kernel start time in clock ticks since boot; a recycled pid cannot match it. */
  startTicks: number
  paneKey: string | null
  tabId: string | null
  worktreeId: string | null
}

// A remote PTY is a direct child of a detached relay whose stdin is a pts —
// node-pty's forkpty child. That excludes relay-watcher.js and every sshd
// session, so the count is exactly "shells the relay is hosting right now".
const LIST_RELAY_REMOTE_PTYS_COMMAND = `
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
  # Field 22 of /proc/pid/stat, addressed past the parenthesised comm so a name
  # with spaces cannot shift the columns.
  stat_line="$(cat "$proc/stat" 2>/dev/null)" || continue
  [ -n "$stat_line" ] || continue
  start="$(printf '%s' "\${stat_line##*) }" | awk '{print $20}')"
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
  printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "\${proc##*/}" "$ppid" "$pts" "$start" "\${pane:--}" "\${tab:--}" "\${worktree:--}"
done
# Why: a shell that exits a proc scan should not fail the census. /proc entries
# vanish mid-scan, and the last one that does would otherwise leave a non-zero
# status that discards every row already printed. Malformed rows are still
# rejected on parse, and docker's own failures never reach this line.
exit 0
`

function optional(value: string | undefined): string | null {
  return value === undefined || value === '' || value === '-' ? null : value
}

export function readDockerSshRelayRemotePtys(
  target: DockerSshRelayTarget
): DockerSshRelayRemotePty[] {
  const output = execDockerSshRelayTargetCommand(target, LIST_RELAY_REMOTE_PTYS_COMMAND)
  if (!output) {
    return []
  }
  return output
    .split('\n')
    .map((line) => {
      const [rawPid, rawRelayPid, pts, rawStartTicks, paneKey, tabId, worktreeId] = line.split('\t')
      const pid = Number(rawPid)
      const relayPid = Number(rawRelayPid)
      const startTicks = Number(rawStartTicks)
      // Why: a vanished /proc entry must throw so expect.poll retries rather
      // than folding a half-read row into the census as pid 0.
      if (
        !Number.isInteger(pid) ||
        !Number.isInteger(relayPid) ||
        !Number.isInteger(startTicks) ||
        rawStartTicks === '' ||
        !pts?.startsWith('/dev/pts/')
      ) {
        throw new Error(`Unexpected Docker SSH relay remote PTY row: ${line}`)
      }
      return {
        pid,
        relayPid,
        pts,
        startTicks,
        paneKey: optional(paneKey),
        tabId: optional(tabId),
        worktreeId: optional(worktreeId)
      }
    })
    .sort((left, right) => left.pid - right.pid)
}

// Why not pgrep -f: the `bash -lc` running the probe carries the marker in its
// own cmdline and would count itself. Requiring argv[0] to be node counts only
// the writers the panes started.
const COUNT_REMOTE_STREAM_WRITERS_COMMAND = `
count=0
for proc in /proc/[0-9]*; do
  [ -r "$proc/cmdline" ] || continue
  argv=()
  mapfile -d '' -t argv < "$proc/cmdline" 2>/dev/null || continue
  [ "\${argv[0]##*/}" = node ] || continue
  case "\${argv[*]}" in *MARKER*) count=$((count + 1)) ;; esac
done
printf '%s' "$count"
`

export function countDockerSshRelayRemoteStreamWriters(
  target: DockerSshRelayTarget,
  marker: string
): number {
  if (!/^[A-Za-z0-9_]+$/.test(marker)) {
    throw new Error(`Stream marker must be shell-safe: ${marker}`)
  }
  const count = Number(
    execDockerSshRelayTargetCommand(
      target,
      COUNT_REMOTE_STREAM_WRITERS_COMMAND.replace('MARKER', marker)
    )
  )
  if (!Number.isInteger(count)) {
    throw new Error(`Unexpected remote stream writer count for ${marker}`)
  }
  return count
}

export function describeDockerSshRelayRemotePtys(ptys: DockerSshRelayRemotePty[]): string {
  return ptys
    .map(
      (pty) =>
        `${pty.pid}@${pty.relayPid} ${pty.pts} start=${pty.startTicks} pane=${pty.paneKey ?? '-'}`
    )
    .join(', ')
}
