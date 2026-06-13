import { execFile, spawn, type ChildProcess } from 'child_process'
import { access, mkdtemp } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const RUNTIME_METADATA_FILE = 'orca-runtime.json'
let orcaDevUserDataPath: string | null = null
let orcaServeProcess: ChildProcess | null = null
let orcaServeStdout = ''
let orcaServeStderr = ''

export type CliResult = {
  stdout: string
  stderr: string
}

type RunOrcaCliOptions = {
  retryMissingRuntimeMetadata?: boolean
}

export async function runOrcaCli(
  args: string[],
  options: RunOrcaCliOptions = {}
): Promise<CliResult> {
  try {
    return await runOrcaCliOnce(args)
  } catch (error) {
    if (
      options.retryMissingRuntimeMetadata !== false &&
      isMissingRuntimeMetadataError(args, error)
    ) {
      // Why: Windows CI can let the dev runtime exit while launching the
      // fixture app; reopen once so the desktop action gets a live runtime.
      await ensureOrcaRuntimeLaunched()
      return await runOrcaCliOnce(args)
    }
    throw error
  }
}

async function runOrcaCliOnce(args: string[]): Promise<CliResult> {
  const devCli = join(process.cwd(), 'config/scripts/orca-dev.mjs')
  const command = process.env.ORCA_COMPUTER_CLI ?? process.execPath
  const cliArgs = process.env.ORCA_COMPUTER_CLI ? args : [devCli, ...args]
  const env = { ...process.env }
  if (!process.env.ORCA_COMPUTER_CLI && !env.ORCA_DEV_USER_DATA_PATH) {
    env.ORCA_DEV_USER_DATA_PATH = await getComputerE2eOrcaDevUserDataPath()
  }
  try {
    const result = await execFileAsync(command, cliArgs, {
      env,
      maxBuffer: 20 * 1024 * 1024
    })
    return { stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    if (error && typeof error === 'object' && 'stdout' in error && 'stderr' in error) {
      const output = error as { message: string; stdout: string; stderr: string }
      throw new Error(`${output.message}\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`)
    }
    throw error
  }
}

export async function ensureOrcaRuntimeLaunched(): Promise<void> {
  if (!process.env.ORCA_COMPUTER_CLI && process.platform === 'win32') {
    await ensureOrcaRuntimeServed()
    return
  }
  await runOrcaCli(['open', '--json'], { retryMissingRuntimeMetadata: false })
  await waitForOrcaRuntimeReady()
}

export async function stopOrcaRuntime(): Promise<void> {
  const processToStop = orcaServeProcess
  if (!processToStop?.pid) {
    return
  }
  orcaServeProcess = null
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(processToStop.pid), '/T', '/F'])
    } catch {
      // The foreground test runtime may already have exited.
    }
    return
  }
  processToStop.kill()
}

export function parseJsonOutput<T>(stdout: string): T {
  return JSON.parse(stdout) as T
}

async function getComputerE2eOrcaDevUserDataPath(): Promise<string> {
  if (!orcaDevUserDataPath) {
    // Why: the shared orca-dev profile can keep an older runtime alive across
    // local test runs, making computer-use E2E exercise stale provider code.
    orcaDevUserDataPath = await mkdtemp(join(tmpdir(), 'orca-computer-runtime-'))
  }
  return orcaDevUserDataPath
}

async function waitForOrcaRuntimeReady(): Promise<void> {
  const userDataPath = await getComputerE2eOrcaDevUserDataPath()
  const metadataPath = join(userDataPath, RUNTIME_METADATA_FILE)
  const deadline = Date.now() + 15000
  let lastError: unknown = null

  while (Date.now() < deadline) {
    try {
      await access(metadataPath)
      const status = parseJsonOutput<{
        result: { runtime: { reachable: boolean } }
      }>((await runOrcaCli(['status', '--json'], { retryMissingRuntimeMetadata: false })).stdout)
      if (status.result.runtime.reachable) {
        return
      }
    } catch (error) {
      lastError = error
    }
    await delay(250)
  }

  const detail = [
    lastError instanceof Error ? `Last error: ${lastError.message}` : null,
    orcaServeStdout.trim() ? `serve stdout: ${orcaServeStdout.trim()}` : null,
    orcaServeStderr.trim() ? `serve stderr: ${orcaServeStderr.trim()}` : null
  ]
    .filter(Boolean)
    .join(' ')
  throw new Error(`Orca runtime metadata was not ready at ${metadataPath}.${detail}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function ensureOrcaRuntimeServed(): Promise<void> {
  if (!orcaServeProcess || orcaServeProcess.exitCode !== null) {
    const devCli = join(process.cwd(), 'config/scripts/orca-dev.mjs')
    const env = {
      ...process.env,
      ORCA_DEV_USER_DATA_PATH: await getComputerE2eOrcaDevUserDataPath()
    }
    orcaServeStdout = ''
    orcaServeStderr = ''
    orcaServeProcess = spawn(process.execPath, [devCli, 'serve', '--no-pairing', '--json'], {
      env,
      windowsHide: true
    })
    orcaServeProcess.stdout?.on('data', (chunk) => {
      orcaServeStdout += String(chunk)
    })
    orcaServeProcess.stderr?.on('data', (chunk) => {
      orcaServeStderr += String(chunk)
    })
    orcaServeProcess.once('exit', () => {
      orcaServeProcess = null
    })
    process.once('exit', () => {
      orcaServeProcess?.kill()
    })
  }
  await waitForOrcaRuntimeReady()
}

function isMissingRuntimeMetadataError(args: string[], error: unknown): boolean {
  if (args[0] !== 'computer') {
    return false
  }
  if (!error || typeof error !== 'object' || !('message' in error)) {
    return false
  }
  const message = String((error as { message?: unknown }).message)
  return (
    message.includes('"code": "runtime_unavailable"') &&
    message.includes('Could not read Orca runtime metadata')
  )
}
