import {
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-process-recognition'
import { tokenizeCommandLine } from './agent-command-line-entrypoint'
import type { AgentProcessIdentity, AgentProcessVerdict } from './agent-process-presence'
import { hasControllingTty } from './posix-controlling-terminal'
import { unreadableArgvName, type ProcessTableRow } from './process-table-snapshot'
import { isShellProcess } from './shell-process-detection'
import type { TmuxHookPane } from './tmux-client-attachment'

/** What the execution host can prove about a hook's process relative to the pane it names.
 *  `root`: the pane's own agent. `nested`: another agent runs it. `competing`: another job or
 *  terminal holds the pane. `unknown`: the evidence is missing or ambiguous. */
export type HookProcessVerdict = 'root' | 'nested' | 'competing' | 'unknown'

/** One bounded evidence read; hooks joining it share its single answer deadline. */
export type HookRootAttempt = {
  /** Undefined once complete: this pane's execution host cannot bind its root (legacy path). */
  verdict?: HookProcessVerdict
  completedAt?: number
  pending?: Promise<void>
  answerBy: number
}

/** The root process of the PTY a pane runs in, named by that PTY's owning provider. */
export type HookPaneRoot = { pid: number; incarnation: string }

export type HookRootEvidenceRequest = {
  paneKey: string
  worktreeId: string | undefined
  /** The hook's own agent; generic runtime argv need not name it. */
  agent: string
  process: AgentProcessIdentity
  tmux?: TmuxHookPane
}

/** Undefined: this pane's executor or endpoint predates root binding, so the legacy path applies. */
export type HookRootEvidenceReader = (
  request: HookRootEvidenceRequest
) => Promise<HookProcessVerdict | undefined>

/** The inner pane an outer pane's foreground tmux client shows. */
export type TmuxPaneBridge = { selected: string; innerPid?: number }

export type HookPaneProcessIo = {
  /** Null when the binding is missing (unknown); 'legacy' when its provider cannot name roots. */
  resolveRoot: (
    paneKey: string,
    worktreeId: string | undefined
  ) => Promise<HookPaneRoot | 'legacy' | null>
  probe: (process: AgentProcessIdentity) => Promise<AgentProcessVerdict>
  readProcesses: (pids: readonly number[]) => Promise<ProcessTableRow[]>
  readTerminal: (tty: string) => Promise<ProcessTableRow[]>
  readTmux?: (socket: string, rootPid: number, pane: string) => Promise<TmuxPaneBridge | null>
}

// Matches the bounded ancestry walk of the common pattern; a pane's agent sits a few levels below its root.
const MAX_ANCESTRY_DEPTH = 32
const MAX_TERMINAL_ROWS = 256

type Role = 'agent' | 'launcher' | 'other' | 'unknown'

function agentOf(command: string): string | undefined {
  const recognized = recognizeAgentProcessFromCommandLine(command, { includeHeadlessOneShot: true })
  if (recognized) {
    return recognized.agent
  }
  // Native installs exec a versioned binary (`…/claude/versions/2.1.0`); its directory names the agent.
  const versioned = /(?:^|\/)([^/]+)\/versions\/\d[^/]*$/.exec(
    tokenizeCommandLine(command)[0] ?? ''
  )
  return versioned ? recognizeAgentProcess(versioned[1])?.agent : undefined
}

function firstToken(command: string): string {
  return (tokenizeCommandLine(command)[0] ?? '').replace(/^-/, '')
}

/** How an ancestor bears on the sender. A shell interpreting a script named after an agent is a
 *  launcher, not that agent; a same-agent process in the sender's own job may be a spawning shim
 *  or a real in-job child, which process metadata cannot tell apart. */
function ancestorRole(row: ProcessTableRow, sender: ProcessTableRow, agent: string): Role {
  if (unreadableArgvName(row.command) !== null) {
    return 'unknown'
  }
  if (isShellProcess(firstToken(row.command))) {
    return 'launcher'
  }
  const recognized = agentOf(row.command)
  if (!recognized) {
    return 'other'
  }
  return recognized !== agent || row.pgid !== sender.pgid ? 'agent' : 'unknown'
}

/** Which kind of job holds a terminal's foreground: an agent, only shells, or something else. */
function foregroundRole(rows: readonly ProcessTableRow[]): 'agent' | 'shell' | 'other' | 'unknown' {
  if (rows.length === 0 || rows.some((row) => unreadableArgvName(row.command) !== null)) {
    return 'unknown'
  }
  if (rows.some((row) => agentOf(row.command))) {
    return 'agent'
  }
  return rows.every((row) => isShellProcess(firstToken(row.command))) ? 'shell' : 'other'
}

type Walk = 'reached' | 'outside' | 'nested' | 'unknown'
/** A sender on another terminal than the pane's: `foreign` when the pane shows its shell or an
 *  agent (it bridges nowhere), `bridged` when its foreground may be a bridge (tmux, screen, sudo). */
type OtherTerminal = 'foreign' | 'bridged'

function walkToRoot(
  byPid: ReadonlyMap<number, ProcessTableRow>,
  sender: ProcessTableRow,
  rootPid: number,
  agent: string
): Walk {
  let row = sender
  for (let depth = 0; depth < MAX_ANCESTRY_DEPTH; depth++) {
    if (row.pid === rootPid) {
      return 'reached'
    }
    if (row.ppid <= 1) {
      return 'outside'
    }
    const parent = byPid.get(row.ppid)
    if (!parent) {
      return 'unknown'
    }
    // macOS panes start under setuid login(1), whose argv another user may not read.
    const role =
      parent.pid === rootPid && unreadableArgvName(parent.command) !== null
        ? 'other'
        : ancestorRole(parent, sender, agent)
    if (role === 'agent') {
      return 'nested'
    }
    if (role === 'unknown') {
      return 'unknown'
    }
    row = parent
  }
  return 'unknown'
}

/** Classify the sender against the named pane root, walking across Claude's detached tool
 *  sessions. `rows` holds the sender's ancestry and every process on the root's terminal. */
export function classifyPaneHookProcess(input: {
  rows: readonly ProcessTableRow[]
  rootPid: number
  senderPid: number
  agent: string
}): HookProcessVerdict | OtherTerminal {
  const byPid = new Map(input.rows.map((row) => [row.pid, row]))
  const root = byPid.get(input.rootPid)
  const sender = byPid.get(input.senderPid)
  if (!root || !sender || !hasControllingTty(root.tty) || !root.tpgid || root.tpgid <= 0) {
    return 'unknown'
  }
  const walk = walkToRoot(byPid, sender, input.rootPid, input.agent)
  if (walk === 'nested' || walk === 'unknown') {
    return walk
  }
  const foreground = input.rows.filter((row) => row.tty === root.tty && row.pgid === root.tpgid)
  if (sender.tty === root.tty) {
    if (walk === 'outside') {
      return 'unknown'
    }
    if (sender.pgid === root.tpgid) {
      return 'root'
    }
    // Why: a shell can start a headless agent in the background while the pane's own agent holds
    // the foreground; only a foreground with no agent leaves the background job the pane's agent.
    const role = foregroundRole(foreground)
    return role === 'agent' ? 'competing' : role === 'unknown' ? 'unknown' : 'root'
  }
  // A detached sender (bare setsid) has no terminal to tie it to this pane.
  if (!hasControllingTty(sender.tty)) {
    return 'unknown'
  }
  const role = foregroundRole(foreground)
  return role === 'agent' || role === 'shell' ? 'foreign' : 'bridged'
}

async function collectRows(
  io: HookPaneProcessIo,
  rootPid: number,
  senderPid: number
): Promise<ProcessTableRow[] | null> {
  const [root] = await io.readProcesses([rootPid])
  if (!root || !hasControllingTty(root.tty)) {
    return null
  }
  const terminal = await io.readTerminal(root.tty)
  if (terminal.length > MAX_TERMINAL_ROWS) {
    return null
  }
  const byPid = new Map(terminal.map((row) => [row.pid, row]))
  byPid.set(root.pid, root)
  let pid = senderPid
  for (let depth = 0; depth <= MAX_ANCESTRY_DEPTH && pid !== rootPid && pid > 1; depth++) {
    let row = byPid.get(pid)
    if (!row) {
      row = (await io.readProcesses([pid]))[0]
      if (!row) {
        break
      }
      byPid.set(pid, row)
    }
    pid = row.ppid
  }
  return [...byPid.values()]
}

async function classifyAgainst(
  io: HookPaneProcessIo,
  rootPid: number,
  request: HookRootEvidenceRequest
): Promise<HookProcessVerdict | OtherTerminal> {
  const rows = await collectRows(io, rootPid, request.process.pid)
  return rows
    ? classifyPaneHookProcess({
        rows,
        rootPid,
        senderPid: request.process.pid,
        agent: request.agent
      })
    : 'unknown'
}

/** Positive pane-membership evidence for a hook's process, read on the pane's execution host
 *  with targeted per-process and per-terminal reads, never a whole-host table. */
export async function readHookRootEvidence(
  request: HookRootEvidenceRequest,
  io: HookPaneProcessIo
): Promise<HookProcessVerdict | undefined> {
  const root = await io.resolveRoot(request.paneKey, request.worktreeId)
  if (root === 'legacy') {
    return undefined
  }
  // The probe pins PID reuse to the hook's start identity before rows name its lineage.
  if (!root || (await io.probe(request.process)) !== 'live') {
    return 'unknown'
  }
  const verdict = await classifyAgainst(io, root.pid, request)
  const { tmux } = request
  // Only a pane whose foreground may bridge (a tmux client) can show another terminal's agent.
  if (verdict !== 'bridged' || !tmux || !io.readTmux) {
    return settleOtherTerminal(verdict)
  }
  // A tmux server may predate the pane, so only the outer pane's foreground client links them.
  const bridge = await io.readTmux(tmux.socket, root.pid, tmux.pane)
  if (!bridge) {
    return 'unknown'
  }
  if (bridge.selected !== tmux.pane) {
    return 'competing'
  }
  const inner = bridge.innerPid
  const innerVerdict = inner ? await classifyAgainst(io, inner, request) : 'unknown'
  const recheck = await io.readTmux(tmux.socket, root.pid, tmux.pane)
  if (recheck?.selected !== tmux.pane || recheck.innerPid !== inner) {
    return 'unknown'
  }
  return settleOtherTerminal(innerVerdict)
}

function settleOtherTerminal(verdict: HookProcessVerdict | OtherTerminal): HookProcessVerdict {
  return verdict === 'foreign' ? 'competing' : verdict === 'bridged' ? 'unknown' : verdict
}

export function hookProcessKey(process: AgentProcessIdentity): string {
  return `${process.platform}\n${process.pid}\n${process.startTime}`
}
