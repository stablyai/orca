import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { getCommandTokenPathBasename, getFirstCommandToken } from './command-token-scanner'

const execFile = promisify(execFileCb)

const TMUX_TIMEOUT_MS = 2000
// Why: mirrors the process-table snapshot TTL so a tmux-hosted pane polled on
// the ~750ms foreground cadence forks `tmux` at most ~2x/sec instead of every
// poll (same fork-pressure concern as the ps snapshot, issue #6288).
const CACHE_TTL_MS = 500

/**
 * True when a ps command line is a tmux *client* we can hop through. Agents run
 * inside tmux are children of the reparented tmux server (ppid 1), never of the
 * pane shell — only the client appears in the shell's subtree, so this is what
 * signals "an agent may be hidden behind tmux".
 */
export function isTmuxClientCommand(command: string): boolean {
  // `tmux: server`/`tmux: client` status lines are not a plain `tmux` invocation.
  return getCommandTokenPathBasename(getFirstCommandToken(command)) === 'tmux'
}

/**
 * Extract the `-L <name>` / `-S <path>` socket selector from a tmux client
 * command so we query the same server the client is attached to. Handles both
 * separated (`-L name`) and glued (`-Lname`) forms; returns [] for the default
 * socket.
 */
export function parseTmuxSocketArgs(command: string): string[] {
  const tokens = command.trim().split(/\s+/).slice(1)
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    for (const flag of ['-L', '-S'] as const) {
      if (token === flag && tokens[i + 1]) {
        return [flag, tokens[i + 1]]
      }
      if (token.startsWith(flag) && token.length > flag.length) {
        return [flag, token.slice(flag.length)]
      }
    }
  }
  return []
}

type TmuxPaneCacheEntry = { panePid: number | null; capturedAtMs: number }
// ponytail: unbounded Map, but keyed by client pid — only a handful of distinct
// tmux clients ever exist in a session, and entries are tiny. Prune if it grows.
const paneCache = new Map<number, TmuxPaneCacheEntry>()

export type ResolveTmuxActivePanePidDeps = {
  runTmux?: (args: string[]) => Promise<string>
  now?: () => number
}

/**
 * Given a tmux client (its pid + command line), return the pid of the pane
 * process backing that client's active window/pane, or null. That pane process
 * roots the subtree where the real agent (e.g. `claude`) lives. Best-effort:
 * any failure resolves to null so foreground detection falls through unchanged.
 */
export async function resolveTmuxActivePanePid(
  clientPid: number,
  clientCommand: string,
  deps: ResolveTmuxActivePanePidDeps = {}
): Promise<number | null> {
  const now = deps.now ?? (() => Date.now())
  const cached = paneCache.get(clientPid)
  if (cached && now() - cached.capturedAtMs < CACHE_TTL_MS) {
    return cached.panePid
  }

  const runTmux =
    deps.runTmux ??
    (async (args: string[]) => {
      const { stdout } = await execFile('tmux', args, {
        encoding: 'utf-8',
        timeout: TMUX_TIMEOUT_MS
      })
      return stdout
    })

  let panePid: number | null = null
  try {
    // `#{pane_pid}` resolves in the client's context to the active pane's pid,
    // so one call maps client -> active pane without a second list-panes query.
    const stdout = await runTmux([
      ...parseTmuxSocketArgs(clientCommand),
      'list-clients',
      '-F',
      '#{client_pid} #{pane_pid}'
    ])
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/)
      if (match && Number(match[1]) === clientPid) {
        panePid = Number(match[2])
        break
      }
    }
  } catch {
    // Best-effort: no tmux / no server / socket gone -> fall through to null.
  }

  paneCache.set(clientPid, { panePid, capturedAtMs: now() })
  return panePid
}

/** Test-only: clear the per-client pane cache between cases. */
export function resetTmuxActivePaneCacheForTests(): void {
  paneCache.clear()
}
