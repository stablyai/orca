import { readFile } from 'node:fs/promises'

import { recognizeAgentProcess } from './agent-process-recognition'
import type { AgentHookSource } from './agent-hook-relay'
import { runProcess } from './child-process/run-process'
import { isResumableTuiAgent } from './agent-session-resume'

export type AgentHookEmitterProcess = { pid: number; startTime: string }
export type AgentHookEmitterProcessResolver = (
  source: AgentHookSource,
  reportedProcessId: number | undefined
) => Promise<AgentHookEmitterProcess | null>

type ProcessRow = AgentHookEmitterProcess & { ppid: number; command: string }

const MAX_EMITTER_ANCESTRY_DEPTH = 16

function parseLinuxStat(pid: number, stat: string, command: string): ProcessRow | null {
  const openingParen = stat.indexOf('(')
  const closingParen = stat.lastIndexOf(')')
  if (openingParen === -1 || closingParen <= openingParen) {
    return null
  }
  const tail = stat
    .slice(closingParen + 1)
    .trim()
    .split(/\s+/)
  const ppid = Number(tail[1])
  const startTime = tail[19]
  const comm = stat.slice(openingParen + 1, closingParen)
  if (!Number.isSafeInteger(ppid) || ppid < 0 || !startTime) {
    return null
  }
  return { pid, ppid, startTime, command: command || comm }
}

async function readLinuxProcess(pid: number): Promise<ProcessRow | null> {
  try {
    const [stat, cmdline] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readFile(`/proc/${pid}/cmdline`, 'utf8')
    ])
    return parseLinuxStat(pid, stat, cmdline.split('\0').filter(Boolean).join(' '))
  } catch {
    return null
  }
}

async function readDarwinProcess(pid: number): Promise<ProcessRow | null> {
  const result = await runProcess({
    program: 'ps',
    args: ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,command='],
    timeoutMs: 1_000,
    maxOutputBytes: 8 * 1024
  })
  if (result.code !== 0 || result.timedOut || result.outputTruncated) {
    return null
  }
  const match = result.stdout
    .trim()
    .match(/^(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d{1,2}\s+\S+\s+\d{4})\s+(.+)$/)
  if (!match) {
    return null
  }
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    startTime: match[3],
    command: match[4]
  }
}

/** Resolve a hook's parent chain to the exact resumable provider process on its execution host. */
export async function resolveAgentHookEmitterProcess(
  source: AgentHookSource,
  reportedProcessId: number | undefined,
  options: {
    platform?: NodeJS.Platform
    readProcess?: (pid: number) => Promise<ProcessRow | null>
  } = {}
): Promise<AgentHookEmitterProcess | null> {
  if (
    !isResumableTuiAgent(source) ||
    !Number.isSafeInteger(reportedProcessId) ||
    Number(reportedProcessId) <= 0
  ) {
    return null
  }
  const platform = options.platform ?? process.platform
  const readProcess =
    options.readProcess ??
    (platform === 'linux' ? readLinuxProcess : platform === 'darwin' ? readDarwinProcess : null)
  if (!readProcess) {
    return null
  }
  const seen = new Set<number>()
  let processId = Number(reportedProcessId)
  for (let depth = 0; depth < MAX_EMITTER_ANCESTRY_DEPTH; depth += 1) {
    if (seen.has(processId)) {
      return null
    }
    seen.add(processId)
    const row = await readProcess(processId)
    if (!row) {
      return null
    }
    const recognized = recognizeAgentProcess(row.command)
    if (recognized) {
      return recognized.agent === source ? { pid: row.pid, startTime: row.startTime } : null
    }
    if (row.ppid <= 0) {
      return null
    }
    processId = row.ppid
  }
  return null
}
