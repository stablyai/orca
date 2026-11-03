import type { AgentProcessIdentity } from './agent-process-presence'

/** The guest PID and Linux start identity of a WSL pane's root shell, printed once by its
 *  provider-owned bootstrap before any user startup file runs. */
export type WslGuestRoot = { pid: number; startTime: string }

// oxlint-disable-next-line no-control-regex -- the marker is an OSC sequence: ESC ... BEL.
const MARKER_RE = /\x1b\]777;orca-wsl-root:(\d{1,10}):([0-9a-f-]{36}):(\d{1,20})\x07/
const MARKER_MAX_LENGTH = 96
// The bootstrap prints before exec'ing the login shell; later output is the user's, never trusted.
const LAUNCH_WINDOW_BYTES = 64 * 1024

/** `sh -c` keeps its PID across `exec`, so the marker names the login shell that follows. The
 *  start identity matches the hook capture's Linux form (`<boot_id>:<starttime>`). */
export const WSL_GUEST_ROOT_MARKER_COMMAND =
  '{ _orca_root=$(awk \'NR==1{b=$0;next}{print b":"$22}\' /proc/sys/kernel/random/boot_id /proc/$$/stat 2>/dev/null) && printf \'\\033]777;orca-wsl-root:%s:%s\\007\' "$$" "$_orca_root"; true; }'

/** Watch a WSL pane's first output for its root marker; never rewrites the stream. */
export function createWslGuestRootObserver(
  onRoot: (root: WslGuestRoot) => void
): (data: string) => void {
  let seen = 0
  let tail = ''
  return (data) => {
    if (seen >= LAUNCH_WINDOW_BYTES) {
      return
    }
    seen += data.length
    const window = tail + data
    const match = MARKER_RE.exec(window)
    if (match) {
      seen = LAUNCH_WINDOW_BYTES
      const pid = Number(match[1])
      if (pid > 1) {
        onRoot({ pid, startTime: `${match[2]}:${match[3]}` })
      }
      return
    }
    tail = window.slice(-MARKER_MAX_LENGTH)
  }
}

export function readWslGuestRoot(value: unknown): WslGuestRoot | undefined {
  if (typeof value !== 'object' || value === null || !('pid' in value) || !('startTime' in value)) {
    return undefined
  }
  const { pid, startTime } = value
  return typeof pid === 'number' &&
    Number.isSafeInteger(pid) &&
    pid > 1 &&
    typeof startTime === 'string' &&
    /^[0-9a-f-]{36}:\d{1,20}$/.test(startTime)
    ? { pid, startTime }
    : undefined
}

export function wslGuestRootIdentity(root: WslGuestRoot): AgentProcessIdentity {
  return { pid: root.pid, platform: 'linux', startTime: root.startTime }
}
