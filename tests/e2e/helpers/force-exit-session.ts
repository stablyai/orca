import { execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { PROTOCOL_VERSION } from '../../../src/main/daemon/types'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../../src/shared/orca-profiles'

const PROCESS_EXIT_TIMEOUT_MS = 5_000
const PROCESS_EXIT_POLL_MS = 50

export type PersistedWorkspaceSession = {
  tabsByWorktree?: Record<string, { id?: unknown; ptyId?: unknown }[]>
  terminalLayoutsByTabId?: Record<string, unknown>
  activeWorktreeIdsOnShutdown?: unknown
  sleepingAgentSessionsByPaneKey?: Record<
    string,
    {
      paneKey?: unknown
      tabId?: unknown
      state?: unknown
      origin?: unknown
      providerSession?: { id?: unknown }
      launchConfig?: {
        agentCommand?: string
        agentArgs?: string
        agentEnv?: Record<string, string>
      }
    }
  >
}

export type PersistedData = {
  workspaceSession?: PersistedWorkspaceSession
}

export function readPersistedData(userDataDir: string): PersistedData {
  // Fresh sessions migrate the seeded legacy file, then persist only here.
  const filePath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  return JSON.parse(readFileSync(filePath, 'utf8')) as PersistedData
}

export function writePersistedData(userDataDir: string, data: PersistedData): void {
  const filePath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export function readDaemonPid(userDataDir: string): number {
  const pidPath = path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`)
  const raw = readFileSync(pidPath, 'utf8')
  const parsed = JSON.parse(raw) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return parsed.pid
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

function waitForExit(proc: ChildProcess, timeoutMs = PROCESS_EXIT_TIMEOUT_MS): Promise<boolean> {
  if (hasExited(proc)) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (exited: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      proc.off('exit', onExit)
      proc.off('close', onExit)
      resolve(exited)
    }
    const onExit = (): void => finish(true)
    const timeout = setTimeout(() => finish(false), timeoutMs)
    proc.once('exit', onExit)
    proc.once('close', onExit)
  })
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitForPidExit(pid: number, timeoutMs = PROCESS_EXIT_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(pid)) {
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, PROCESS_EXIT_POLL_MS)
    })
  }
  return true
}

function terminationFailure(target: string, killError: unknown): Error {
  const detail = killError instanceof Error ? ` Kill failed: ${killError.message}` : ''
  return new Error(`Timed out waiting for ${target} to exit.${detail}`)
}

export async function forceKillElectronApp(app: ElectronApplication): Promise<void> {
  const proc = app.process()
  if (!proc.pid || hasExited(proc)) {
    return
  }
  let killError: unknown
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(proc.pid, 'SIGKILL')
    }
  } catch (error) {
    killError = error
  }
  if (!(await waitForExit(proc))) {
    throw terminationFailure(`Electron process ${proc.pid}`, killError)
  }
}

export async function forceKillProcessTree(pid: number): Promise<void> {
  if (!isProcessAlive(pid)) {
    return
  }
  let killError: unknown
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch (error) {
    killError = error
  }
  // Why: a restart test is meaningless if the old daemon survived the kill attempt.
  if (!(await waitForPidExit(pid))) {
    throw terminationFailure(`daemon process ${pid}`, killError)
  }
}
