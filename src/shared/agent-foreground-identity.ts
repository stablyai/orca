import { recognizeAgentProcess } from './agent-process-recognition'
import { readAgentProcess, type AgentProcessObservation } from './agent-process-presence-probe'
import type { AgentProcessPresence } from './agent-process-presence'

export type AgentForegroundObservation = {
  available: boolean
  processName: string | null
  /** The process supplying the name; absent for fallback or ambiguous names. */
  processId?: number
  /** Same snapshot: Linux start ticks, Darwin UTC C-locale lstart, or Windows creation milliseconds. */
  processStartTime?: string
}

/** Both sides are macOS lstart printed with TZ=UTC0 and C time names. */
function sameUtcStartTime(table: string, probe: string): boolean {
  const at = Date.parse(`${table} UTC`)
  return Number.isFinite(at) && at === Date.parse(`${probe} UTC`)
}

/** A name-only fallback cannot own a terminal, even if it names a known agent. */
export async function captureAgentForegroundIdentity(
  readForeground: () => Promise<AgentForegroundObservation>,
  readProcess: (pid: number) => Promise<AgentProcessObservation> = readAgentProcess,
  platform: NodeJS.Platform = process.platform
): Promise<AgentProcessPresence | undefined> {
  if (platform !== 'darwin' && platform !== 'linux' && platform !== 'win32') {
    return undefined
  }
  const observed = await readForeground()
  const agent = recognizeAgentProcess(observed.processName)
  const pid = observed.processId
  if (!observed.available || !agent || !pid) {
    return undefined
  }
  const before = await readProcess(pid)
  if (before.verdict !== 'live' || before.zombie || before.stopped) {
    return undefined
  }
  // The cached name must belong to the same lifetime, not a recycled PID.
  if (platform === 'win32' && before.startTime !== observed.processStartTime) {
    return undefined
  }
  if (platform !== 'win32') {
    if (before.foreground !== true || !observed.processStartTime) {
      return undefined
    }
    const matches =
      platform === 'linux'
        ? before.startTime.endsWith(`:${observed.processStartTime}`)
        : sameUtcStartTime(observed.processStartTime, before.startTime)
    if (!matches) {
      return undefined
    }
  }
  const after = await readProcess(pid)
  if (
    after.verdict !== 'live' ||
    after.zombie ||
    after.stopped ||
    after.startTime !== before.startTime ||
    (platform !== 'win32' && after.foreground !== true)
  ) {
    return undefined
  }
  return { agent: agent.agent, process: { pid, platform, startTime: after.startTime } }
}
