import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import {
  recognizeAgentProcessFromCommandLine,
  tokenizeProcessCommandLine
} from './agent-process-recognition'
import { getFirstCommandToken } from './command-token-scanner'
import type { ProcessTableRow } from './process-table-snapshot'

const execFile = promisify(execFileCb)
const TMUX_QUERY_TIMEOUT_MS = 2_000
const TMUX_CLIENT_FORMAT = '#{client_pid}\t#{pane_pid}\t#{pane_current_command}'
const TMUX_COMMANDS = new Set(['tmux'])
const TMUX_SESSION_COMMANDS = new Set(['attach', 'attach-session', 'a', 'new', 'new-session'])

type TmuxServerInvocation = {
  executable: string
  serverArgs: string[]
  subcommand: string | null
}

export type TmuxPaneProcess = {
  panePid: number
  currentCommand: string
}

function normalizedCommandName(token: string | undefined): string {
  const basename =
    (token ?? '')
      .trim()
      .replace(/^["']|["']$/g, '')
      .split(/[\\/]/)
      .pop() ?? ''
  return basename.toLowerCase().replace(/\.exe$/, '')
}

function tmuxServerInvocation(commandLine: string): TmuxServerInvocation | null {
  const tokens = tokenizeProcessCommandLine(commandLine)
  if (!TMUX_COMMANDS.has(normalizedCommandName(tokens[0]))) {
    return null
  }
  const serverArgs: string[] = []
  let subcommand: string | null = null
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '-L' || token === '-S') {
      const value = tokens[index + 1]
      if (!value) {
        return null
      }
      serverArgs.push(token, value)
      index += 1
      continue
    }
    if (token.startsWith('-L') || token.startsWith('-S')) {
      serverArgs.push(token)
      continue
    }
    if (token === '-c' || token === '-f' || token === '-T') {
      index += 1
      continue
    }
    if (!token.startsWith('-')) {
      subcommand = token.toLowerCase()
      break
    }
  }
  return { executable: tokens[0], serverArgs, subcommand }
}

export function isTmuxProcessCommand(commandLine: string | null | undefined): boolean {
  return typeof commandLine === 'string' && tmuxServerInvocation(commandLine) !== null
}

export function isTmuxSessionCommand(commandLine: string | null | undefined): boolean {
  if (!commandLine) {
    return false
  }
  const invocation = tmuxServerInvocation(commandLine)
  return (
    invocation !== null &&
    (invocation.subcommand === null || TMUX_SESSION_COMMANDS.has(invocation.subcommand))
  )
}

function parseTmuxPaneProcess(stdout: string, clientPid: number): TmuxPaneProcess | null {
  for (const line of stdout.split(/\r?\n/)) {
    const [clientPidText, panePidText, ...commandParts] = line.split('\t')
    if (Number(clientPidText) !== clientPid) {
      continue
    }
    const panePid = Number(panePidText)
    if (!Number.isSafeInteger(panePid) || panePid <= 0) {
      return null
    }
    return { panePid, currentCommand: commandParts.join('\t').trim() }
  }
  return null
}

export async function readTmuxClientPane(
  clientCommandLine: string,
  clientPid: number
): Promise<TmuxPaneProcess | null> {
  const invocation = tmuxServerInvocation(clientCommandLine)
  if (!invocation) {
    return null
  }
  try {
    const { stdout } = await execFile(
      invocation.executable,
      [...invocation.serverArgs, 'list-clients', '-F', TMUX_CLIENT_FORMAT],
      { encoding: 'utf8', timeout: TMUX_QUERY_TIMEOUT_MS }
    )
    return parseTmuxPaneProcess(stdout, clientPid)
  } catch {
    return null
  }
}

function collectPaneProcesses(rows: ProcessTableRow[], rootPid: number): ProcessTableRow[] {
  const childrenByParent = new Map<number, ProcessTableRow[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row)
    childrenByParent.set(row.ppid, children)
  }
  const processes: ProcessTableRow[] = []
  const stack = [rootPid]
  const visited = new Set<number>()
  while (stack.length > 0) {
    const pid = stack.pop()!
    if (visited.has(pid)) {
      continue
    }
    visited.add(pid)
    const row = rows.find((candidate) => candidate.pid === pid)
    if (row) {
      processes.push(row)
    }
    for (const child of childrenByParent.get(pid) ?? []) {
      stack.push(child.pid)
    }
  }
  return processes
}

export async function resolveTmuxPaneForegroundProcess(
  rows: ProcessTableRow[],
  client: ProcessTableRow
): Promise<string | null> {
  const pane = await readTmuxClientPane(client.command, client.pid)
  if (!pane) {
    return null
  }
  const processes = collectPaneProcesses(rows, pane.panePid)
  const foregroundKnown = processes.some((row) => row.stat.includes('+'))
  for (const row of processes) {
    if (foregroundKnown && !row.stat.includes('+')) {
      continue
    }
    const recognized = recognizeAgentProcessFromCommandLine(row.command)
    if (recognized) {
      return recognized.processName
    }
  }
  return pane.currentCommand || getFirstCommandToken(processes[0]?.command ?? '') || null
}
