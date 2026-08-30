import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import { getCommandTokenPathBasename, getFirstCommandToken } from './command-token-scanner'
import { resolveOuterWrapperForegroundProcess } from './foreground-wrapper-agent'
import type { ProcessTableRow } from './process-table-snapshot'

const execFile = promisify(execFileCb)

const TMUX_QUERY_TIMEOUT_MS = 2000

type ScoredRow = ProcessTableRow & { depth: number }

/** True when a process-table command (or a bare process name) is the `tmux` binary. */
export function isTmuxCommand(command: string): boolean {
  return getCommandTokenPathBasename(getFirstCommandToken(command)) === 'tmux'
}

function collectDescendants(rows: ProcessTableRow[], rootPid: number): ScoredRow[] {
  const childrenByParent = new Map<number, ProcessTableRow[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }
  const descendants: ScoredRow[] = []
  const stack = (childrenByParent.get(rootPid) ?? []).map((row) => ({
    row,
    depth: 1
  }))
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!
    descendants.push({ ...row, depth })
    for (const child of childrenByParent.get(row.pid) ?? []) {
      stack.push({ row: child, depth: depth + 1 })
    }
  }
  return descendants
}

function candidateScore(row: ScoredRow): number {
  return (row.stat.includes('+') ? 10_000 : 0) + row.depth
}

// Why: re-run agent recognition rooted at a tmux pane (or reparented server)
// pid. The root pid can BE the agent (a pane launched straight into `claude`,
// no intervening shell), so the root row is included with its descendants.
function recognizeAgentFromSubtree(rows: ProcessTableRow[], rootPid: number): string | null {
  const rootRow = rows.find((row) => row.pid === rootPid)
  const rootCandidate: ScoredRow[] = rootRow ? [{ ...rootRow, depth: 0 }] : []
  const candidates = [...rootCandidate, ...collectDescendants(rows, rootPid)].sort(
    (a, b) => candidateScore(b) - candidateScore(a)
  )
  const foregroundIsKnown =
    rootRow?.stat.includes('+') === true ||
    candidates.some((candidate) => candidate.stat.includes('+'))
  for (const candidate of candidates) {
    if (foregroundIsKnown && !candidate.stat.includes('+')) {
      continue
    }
    const recognized = recognizeAgentProcessFromCommandLine(candidate.command)
    if (recognized) {
      return resolveOuterWrapperForegroundProcess(recognized, candidate, candidates)
    }
  }
  return null
}

export type RunTmux = (args: string[]) => Promise<string>

const defaultRunTmux: RunTmux = async (args) => {
  const { stdout } = await execFile('tmux', args, {
    encoding: 'utf-8',
    timeout: TMUX_QUERY_TIMEOUT_MS
  })
  return stdout
}

/**
 * Recover an agent that a downward process-tree walk cannot see because it runs
 * inside tmux.
 *
 * tmux double-forks its server and reparents it to pid 1, so an agent started in
 * a tmux window is a child of the tmux SERVER, not of the pane shell whose
 * subtree we walked — the walk reaches only the tmux CLIENT and the pane reads
 * as `tmux`. Hop the fork: map the tmux client(s) found in our subtree to their
 * active pane pid via `tmux list-clients` and re-run recognition from there; if
 * tmux is unreachable (wrong socket, not on PATH, no server), fall back to the
 * reparented tmux server pids visible in the ps table. Best-effort and
 * POSIX-only — every failure mode returns null so callers keep their existing
 * fallback. See issue #7797.
 */
export async function resolveTmuxForegroundAgent(params: {
  rows: ProcessTableRow[]
  tmuxClientPids: number[]
  runTmux?: RunTmux
}): Promise<string | null> {
  const { rows, tmuxClientPids } = params
  const runTmux = params.runTmux ?? defaultRunTmux

  const paneRoots: number[] = []

  // Precise: ask tmux which pane each of our clients is currently viewing.
  if (tmuxClientPids.length > 0) {
    try {
      const stdout = await runTmux(['list-clients', '-F', '#{client_pid} #{pane_pid}'])
      const wanted = new Set(tmuxClientPids)
      for (const line of stdout.split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/)
        if (match && wanted.has(Number(match[1]))) {
          paneRoots.push(Number(match[2]))
        }
      }
    } catch {
      // tmux not reachable from here — fall back to the ps table below.
    }
  }

  // Fallback: the reparented tmux server(s) visible in the process table.
  if (paneRoots.length === 0) {
    for (const row of rows) {
      if (row.ppid === 1 && isTmuxCommand(row.command)) {
        paneRoots.push(row.pid)
      }
    }
  }

  const seen = new Set<number>()
  for (const rootPid of paneRoots) {
    if (seen.has(rootPid)) {
      continue
    }
    seen.add(rootPid)
    const recognized = recognizeAgentFromSubtree(rows, rootPid)
    if (recognized) {
      return recognized
    }
  }
  return null
}
