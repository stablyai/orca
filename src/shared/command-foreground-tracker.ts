import { isAgentForegroundWrapperProcess, recognizeAgentProcess } from './agent-process-recognition'
import { FOREGROUND_COMMAND_READS } from './foreground-command-settle'
import { isShellProcess } from './shell-process-detection'

/** What ran in a pane's foreground during its last command, as the executing host read it. */
export type CommandForeground =
  | { kind: 'agent'; agent: string }
  /** A program the recognizer does not name as an agent. */
  | { kind: 'program' }
  /** No read named it: unavailable, or only the shell or a launcher was seen. */
  | { kind: 'unknown' }

/** What the shared command-end rule reads. */
export type CommandEnd = {
  foreground: CommandForeground
  /** Host clock at the command's start; null when the host saw no start. */
  startedAt: number | null
  /** Host clock at its end: a row reported after it is newer than the command. */
  finishedAt: number
}

export type FinishedCommand = CommandEnd & {
  /** False when a fresh read finds a non-shell holding the terminal: a nested shell's leaked end. */
  promptReturned: () => Promise<boolean>
}

export type ForegroundRead = { available: boolean; process: string | null }

type CommandState = {
  id: number
  startedAt: number
  foreground: CommandForeground
  timer: ReturnType<typeof setTimeout> | null
  reading: boolean
}

// Launchers that can still exec an agent after the first read (`npx`/`bunx opencode-ai run`).
const LAUNCHERS = new Set(['node', 'bun', 'bunx', 'npx', 'npm', 'pnpm', 'pnpx', 'yarn'])

function processBase(processName: string): string {
  return (processName.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd)$/, '')
}

/** A shell has not exec'd its command yet, and a launcher may still exec an agent. */
export function mayStillExecAnAgent(processName: string): boolean {
  return (
    recognizeAgentProcess(processName) === null &&
    (isShellProcess(processName) || LAUNCHERS.has(processBase(processName)))
  )
}

function classify(read: ForegroundRead): CommandForeground {
  const process = read.available ? read.process : null
  if (!process || isAgentForegroundWrapperProcess(process) || mayStillExecAnAgent(process)) {
    return { kind: 'unknown' }
  }
  const agent = recognizeAgentProcess(process)?.agent
  return agent ? { kind: 'agent', agent } : { kind: 'program' }
}

/**
 * Names the agent each command ran in a pane's foreground, from the host's process table: one read
 * on each agent report while the command runs, plus the shared start ladder where a consumer needs
 * it. Every read names the real foreground, so a background agent's report never makes it look
 * foreground.
 */
export class CommandForegroundTracker {
  private readonly commands = new Map<string, CommandState>()
  private nextId = 0

  constructor(
    private readonly deps: {
      read: (key: string) => Promise<ForegroundRead>
      /** Fresh, uncached name of the process group holding the terminal; null when unreadable. */
      readTerminalForeground?: (key: string) => Promise<string | null>
      now: () => number
      /** Whether this command also gets the start ladder (a consumer that has no reports to wait for). */
      readsOnStart?: (key: string) => boolean
      /** Every named foreground read during a command. */
      onSample?: (key: string, process: string, commandId: number) => void
    }
  ) {}

  /** Returns the command's id, which every sample of it carries. */
  started(key: string): number {
    this.forget(key)
    const state: CommandState = {
      id: ++this.nextId,
      startedAt: this.deps.now(),
      foreground: { kind: 'unknown' },
      timer: null,
      reading: false
    }
    this.commands.set(key, state)
    if (this.deps.readsOnStart?.(key)) {
      this.schedule(key, state, 0)
    }
    return state.id
  }

  /** An agent reported in this pane: read who holds its foreground while the command runs. */
  observeActivity(key: string): void {
    const state = this.commands.get(key)
    if (state && state.foreground.kind !== 'agent') {
      void this.sample(key, state)
    }
  }

  /** The command's end, read only when a row would end on it. */
  finished(key: string): FinishedCommand {
    const state = this.commands.get(key)
    const finishedAt = this.deps.now()
    this.forget(key)
    let promptReturned: Promise<boolean> | undefined
    return {
      foreground: state?.foreground ?? { kind: 'unknown' },
      startedAt: state?.startedAt ?? null,
      finishedAt,
      // Why fresh: a cached read still names the agent that just exited, or a job Ctrl-Z stopped.
      promptReturned: () =>
        (promptReturned ??= (this.deps.readTerminalForeground?.(key) ?? Promise.resolve(null))
          .catch(() => null)
          .then((process) => process === null || isShellProcess(process)))
    }
  }

  forget(key: string): void {
    const state = this.commands.get(key)
    if (state?.timer) {
      clearTimeout(state.timer)
    }
    this.commands.delete(key)
  }

  private schedule(key: string, state: CommandState, retryIndex: number): void {
    const delay =
      retryIndex === 0
        ? FOREGROUND_COMMAND_READS.settleMs
        : FOREGROUND_COMMAND_READS.retryDelaysMs[retryIndex - 1]
    if (delay === undefined) {
      return
    }
    state.timer = setTimeout(() => {
      state.timer = null
      void this.sample(key, state).then((process) => {
        if (this.commands.get(key) !== state) {
          return
        }
        // Why: a report's read was in flight, so this rung read nothing; take it again.
        if (process === undefined) {
          this.schedule(key, state, retryIndex)
        } else if (process && mayStillExecAnAgent(process)) {
          this.schedule(key, state, retryIndex + 1)
        }
      })
    }, delay)
  }

  /** The process read, or undefined when another read was already in flight. */
  private async sample(key: string, state: CommandState): Promise<string | null | undefined> {
    // Why: a read already in flight names the same foreground, so a report during it adds nothing.
    if (state.reading) {
      return undefined
    }
    state.reading = true
    try {
      const read = await this.deps.read(key).catch(() => ({ available: false, process: null }))
      if (this.commands.get(key) !== state) {
        return null
      }
      const seen = classify(read)
      // Why an agent wins: a program before it (`sleep 1; codex`) never names the command's agent.
      if (
        seen.kind === 'agent' ||
        (seen.kind === 'program' && state.foreground.kind === 'unknown')
      ) {
        state.foreground = seen
      }
      const process = read.available ? read.process : null
      if (process) {
        this.deps.onSample?.(key, process, state.id)
      }
      return process
    } finally {
      state.reading = false
    }
  }
}
