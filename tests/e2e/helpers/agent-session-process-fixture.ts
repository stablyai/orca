import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type AgentSessionSpawnRecord = {
  pid: number
  ppid: number
  spawnedAt: number
  argv: string[]
}

export type AgentSessionLifecycleRecord = {
  pid: number
  ppid: number
  recordedAt: number
  event: string
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-paired-agent-ownership-'))
const spawnMarkerPath = path.join(scratch, 'agent-spawns.txt')
const inputMarkerPath = path.join(scratch, 'agent-input.txt')
const lifecycleMarkerPath = path.join(scratch, 'agent-lifecycle.txt')
const exitTriggerPath = path.join(scratch, 'exit-agent')
const fixtureScript = path.join(
  process.cwd(),
  'config',
  'scripts',
  'remote-agent-session-repro-fixture.mjs'
)

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function fixtureCommand(): string {
  const command = [process.execPath, fixtureScript]
  return process.platform === 'win32'
    ? `& ${command.map((value) => `'${value.replaceAll("'", "''")}'`).join(' ')}`
    : command.map(shellQuote).join(' ')
}

function readMarkerLines(markerPath: string): string[] {
  return existsSync(markerPath)
    ? readFileSync(markerPath, 'utf8').split(/\r?\n/).filter(Boolean)
    : []
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function removeScratchDirectory(): Promise<void> {
  if (process.platform === 'win32') {
    try {
      execFileSync('attrib.exe', ['-R', '-H', '-S', path.join(scratch, '*'), '/S', '/D'], {
        stdio: 'ignore'
      })
    } catch {
      // The directory may already be empty.
    }
  }
  rmSync(scratch, {
    recursive: true,
    force: true,
    maxRetries: 100,
    retryDelay: 100
  })
}

export const agentSessionProcessFixture = {
  launchEnv: {
    ORCA_REPRO_EXIT_TRIGGER: exitTriggerPath,
    ORCA_REPRO_INPUT_MARKER: inputMarkerPath,
    ORCA_REPRO_LIFECYCLE_MARKER: lifecycleMarkerPath,
    ORCA_REPRO_SPAWN_MARKER: spawnMarkerPath
  },
  command: fixtureCommand(),
  reset(): void {
    for (const markerPath of [
      spawnMarkerPath,
      inputMarkerPath,
      lifecycleMarkerPath,
      exitTriggerPath
    ]) {
      rmSync(markerPath, { force: true })
    }
  },
  readSpawns(): AgentSessionSpawnRecord[] {
    return readMarkerLines(spawnMarkerPath).map((line) => {
      const [pid, ppid, spawnedAt, ...argvParts] = line.split(':')
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        spawnedAt: Number(spawnedAt),
        argv: JSON.parse(argvParts.join(':')) as string[]
      }
    })
  },
  readLifecycle(): AgentSessionLifecycleRecord[] {
    return readMarkerLines(lifecycleMarkerPath).map((line) => {
      const [pid, ppid, recordedAt, ...eventParts] = line.split(':')
      return {
        pid: Number(pid),
        ppid: Number(ppid),
        recordedAt: Number(recordedAt),
        event: eventParts.join(':')
      }
    })
  },
  readInput(): string {
    return existsSync(inputMarkerPath) ? readFileSync(inputMarkerPath, 'utf8') : ''
  },
  livePids(): number[] {
    return this.readSpawns()
      .map((spawn) => spawn.pid)
      .filter(isProcessAlive)
  },
  requestExit(): void {
    writeFileSync(exitTriggerPath, '')
  },
  async dispose(): Promise<void> {
    this.requestExit()
    for (let attempt = 0; attempt < 50 && this.livePids().length > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    for (const pid of this.livePids()) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // The fixture may exit between liveness inspection and signaling.
      }
    }
    await removeScratchDirectory()
  }
}
