import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import type { AgentProcessIdentity, AgentProcessVerdict } from './agent-process-presence'
import { getProcessTableIndex } from './process-table-index'
import { unreadableArgvName, type ProcessTableRow } from './process-table-snapshot'

/** What the execution host can prove about a hook's process relative to its pane.
 *  `root`: the pane's own agent. `nested`: an agent runs above it in the pane. `competing`: a
 *  background job while an agent holds the pane's foreground. `unknown`: the evidence is missing. */
export type HookProcessVerdict = 'root' | 'nested' | 'competing' | 'unknown'

export type HookRootEvidenceReader = (process: AgentProcessIdentity) => Promise<HookProcessVerdict>

// Matches the bounded ancestry walk of the common pattern; a pane's agent sits a few levels below its shell.
const MAX_ANCESTRY_DEPTH = 32

function hasTerminal(row: ProcessTableRow): boolean {
  return row.tty !== undefined && row.tty !== '?' && row.tty !== '??'
}

/** An unreadable argv could be an agent, so it proves nothing either way. */
function readAgent(row: ProcessTableRow): boolean | undefined {
  if (unreadableArgvName(row.command) !== null) {
    return undefined
  }
  return (
    recognizeAgentProcessFromCommandLine(row.command, { includeHeadlessOneShot: true }) !== null
  )
}

/** Classify `pid` from one process table. The walk stays inside the process's terminal session,
 *  whose leader is the pane's shell (or the agent itself when it was exec'd or launched directly). */
export function classifyHookProcessRoot(
  rows: readonly ProcessTableRow[],
  pid: number
): HookProcessVerdict {
  const { byPid } = getProcessTableIndex(rows)
  const self = byPid.get(pid)
  if (
    !self ||
    !hasTerminal(self) ||
    self.pgid === undefined ||
    self.tpgid === undefined ||
    self.tpgid <= 0
  ) {
    return 'unknown'
  }
  let row = self
  for (let depth = 0; !row.stat.includes('s'); depth++) {
    const parent = byPid.get(row.ppid)
    if (!parent || depth >= MAX_ANCESTRY_DEPTH || parent.tty !== self.tty) {
      return 'unknown'
    }
    const agent = readAgent(parent)
    if (agent !== false) {
      return agent ? 'nested' : 'unknown'
    }
    row = parent
  }
  if (self.pgid === self.tpgid) {
    return 'root'
  }
  // Why: a shell can start a headless agent in the background while the pane's own agent holds
  // the foreground; only a foreground without an agent leaves the background job the pane's agent.
  for (const member of rows) {
    if (member.pgid === self.tpgid && member.tty === self.tty) {
      const agent = readAgent(member)
      if (agent !== false) {
        return agent ? 'competing' : 'unknown'
      }
    }
  }
  return 'root'
}

/** One validated read per attempt; concurrent hooks from one process share it. */
export function createHookRootEvidenceReader(deps: {
  probe: (process: AgentProcessIdentity) => Promise<AgentProcessVerdict>
  readTable: () => Promise<readonly ProcessTableRow[]>
}): HookRootEvidenceReader {
  const pending = new Map<string, Promise<HookProcessVerdict>>()
  return (process) => {
    const key = hookProcessKey(process)
    const inFlight = pending.get(key)
    if (inFlight) {
      return inFlight
    }
    const read = (async (): Promise<HookProcessVerdict> => {
      // The probe pins PID reuse to the hook's start identity before the table names its lineage.
      if ((await deps.probe(process)) !== 'live') {
        return 'unknown'
      }
      return classifyHookProcessRoot(await deps.readTable(), process.pid)
    })()
      .catch(() => 'unknown' as const)
      .finally(() => pending.delete(key))
    pending.set(key, read)
    return read
  }
}

export function hookProcessKey(process: AgentProcessIdentity): string {
  return `${process.platform}\n${process.pid}\n${process.startTime}`
}
