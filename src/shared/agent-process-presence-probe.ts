import { readFile } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'
import type { AgentProcessIdentity, AgentProcessVerdict } from './agent-process-presence'

export type AgentProcessObservation =
  | { verdict: 'live'; startTime: string; zombie: boolean; stopped?: boolean }
  | { verdict: 'unverifiable' | 'exited' }

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error && 'code' in error && (error.code === 'ESRCH' || error.code === 'ENOENT')
  )
}

export async function readAgentProcess(pid: number): Promise<AgentProcessObservation> {
  try {
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error) => {
        if (isMissing(error)) {
          return null
        }
        throw error
      })
      if (stat === null) {
        return { verdict: 'exited' }
      }
      const fields = stat
        .slice(stat.lastIndexOf(')') + 2)
        .trim()
        .split(/\s+/)
      const boot = (
        await readFile('/proc/sys/kernel/random/boot_id', 'utf8').catch(() => '')
      ).trim()
      if (!/^\d+$/.test(fields[19] ?? '') || !boot) {
        return { verdict: 'unverifiable' }
      }
      return {
        verdict: 'live',
        startTime: `${boot}:${fields[19]}`,
        zombie: fields[0] === 'Z',
        stopped: fields[0] === 'T' || fields[0] === 't'
      }
    }
    if (process.platform === 'darwin') {
      const result = await runProcess({
        program: '/bin/ps',
        args: ['-p', String(pid), '-o', 'stat=,lstart='],
        // Pin the hook capture's zone/locale so local-time lstart strings compare.
        env: { ...process.env, TZ: 'UTC0', LC_ALL: 'C', LANG: 'C' },
        timeoutMs: 1000,
        maxOutputBytes: 4096
      })
      if (!result.timedOut && result.code === 0) {
        const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(result.stdout)
        if (match) {
          return {
            verdict: 'live',
            startTime: match[2],
            zombie: match[1].startsWith('Z'),
            stopped: match[1].startsWith('T')
          }
        }
      }
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (isMissing(error)) {
          return { verdict: 'exited' }
        }
      }
    }
  } catch {
    return { verdict: 'unverifiable' }
  }
  // Windows hooks capture no comparable process identity yet.
  return { verdict: 'unverifiable' }
}

export async function probeAgentProcessPresence(
  identity: AgentProcessIdentity | undefined,
  read: (pid: number) => Promise<AgentProcessObservation> = readAgentProcess,
  platform: NodeJS.Platform = process.platform,
  onSuspensionObserved?: (suspended: boolean) => void
): Promise<AgentProcessVerdict> {
  if (!identity || identity.platform !== platform) {
    return 'unverifiable'
  }
  const observed = await read(identity.pid).catch(() => ({ verdict: 'unverifiable' as const }))
  if (observed.verdict !== 'live') {
    return observed.verdict
  }
  if (observed.zombie || observed.startTime !== identity.startTime) {
    return 'exited'
  }
  onSuspensionObserved?.(observed.stopped === true)
  // Ctrl-Z suspension proves existence but not active terminal ownership.
  return observed.stopped ? 'unverifiable' : 'live'
}
